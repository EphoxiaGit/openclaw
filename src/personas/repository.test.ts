import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { PersonaConflictError, PersonaRepository } from "./repository.js";

const dirs: string[] = [];
const agents = new Set(["main", "delegate"]);
const content = {
  identity: "A careful collaborator.",
  relationship: "A trusted working partner.",
  communicationStyle: "Clear and concise.",
  behaviorGuidance: "Ask only when authority is required.",
  traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};

afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("PersonaRepository", () => {
  it("persists immutable revisions, selections, metadata history, and Agent references", () => {
    const dbPath = path.join(makeTempDir(dirs, "personas-"), "state.sqlite");
    const repository = new PersonaRepository({ path: dbPath, now: () => 100 });
    const persona = repository.create({
      slug: "lucy",
      displayName: "Lucy",
      description: "Primary companion",
      primaryAgentId: "main",
      allowedDelegateAgentIds: ["delegate"],
      revision: content,
      actorId: "device:test",
      authorId: "device:test",
      reason: "Initial revision",
      idempotencyKey: "create-lucy",
      configuredAgentIds: agents,
    });
    const revised = repository.revise({
      personaId: persona.personaId,
      expectedRevision: 1,
      content: { ...content, communicationStyle: "Warm and direct." },
      reason: "Tune communication",
      actorId: "device:test",
      authorId: "device:test",
      idempotencyKey: "revise-lucy",
      configuredAgentIds: agents,
    });
    const selection = repository.setSelection({
      sessionKey: "agent:main:main",
      personaId: persona.personaId,
      expectedRevision: 0,
      idempotencyKey: "select-lucy",
      actorId: "device:test",
      configuredAgentIds: agents,
    });

    expect(revised.revision.revisionNumber).toBe(2);
    expect(repository.listRevisions(persona.personaId)).toHaveLength(2);
    expect(selection?.recordRevision).toBe(1);
    expect(repository.listAgentReferences("delegate")).toEqual([persona.personaId]);
    expect(JSON.stringify(repository.history(persona.personaId))).not.toContain("Warm and direct");

    closeOpenClawStateDatabaseForTest();
    const reopened = new PersonaRepository({ path: dbPath });
    expect(reopened.get(persona.personaId, agents).activeRevisionId).toBe(
      revised.revision.revisionId,
    );
    expect(reopened.getSelection("agent:main:main")?.personaId).toBe(persona.personaId);
  });

  it("rejects stale writes and clears selections when archived", () => {
    const dbPath = path.join(makeTempDir(dirs, "personas-cas-"), "state.sqlite");
    const repository = new PersonaRepository({ path: dbPath });
    const persona = repository.create({
      slug: "lucy",
      displayName: "Lucy",
      description: "",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision: content,
      actorId: "device:test",
      authorId: "device:test",
      reason: "Initial revision",
      idempotencyKey: "create-lucy",
      configuredAgentIds: agents,
    });
    repository.setSelection({
      sessionKey: "agent:main:main",
      personaId: persona.personaId,
      expectedRevision: 0,
      idempotencyKey: "select-lucy",
      actorId: "device:test",
      configuredAgentIds: agents,
    });
    repository.setSelection({
      sessionKey: "agent:main:main",
      expectedRevision: 1,
      idempotencyKey: "clear-lucy",
      actorId: "device:test",
      configuredAgentIds: agents,
    });
    expect(repository.history(persona.personaId).at(-1)).toMatchObject({
      personaId: persona.personaId,
      action: "selection_clear",
      metadata: { sessionKey: "agent:main:main", recordRevision: 0 },
    });
    repository.setSelection({
      sessionKey: "agent:main:main",
      personaId: persona.personaId,
      expectedRevision: 0,
      idempotencyKey: "select-lucy-again",
      actorId: "device:test",
      configuredAgentIds: agents,
    });
    expect(() =>
      repository.update({
        personaId: persona.personaId,
        expectedRevision: 0,
        idempotencyKey: "stale",
        actorId: "device:test",
        configuredAgentIds: agents,
        displayName: "Stale",
      }),
    ).toThrow(PersonaConflictError);
    const archived = repository.setStatus({
      personaId: persona.personaId,
      status: "archived",
      expectedRevision: 1,
      idempotencyKey: "archive",
      actorId: "device:test",
      configuredAgentIds: agents,
    });
    expect(archived.clearedSessionKeys).toEqual(["agent:main:main"]);
    expect(repository.getSelection("agent:main:main")).toBeUndefined();
  });

  it("reports a stable conflict for a duplicate slug", () => {
    const dbPath = path.join(makeTempDir(dirs, "personas-slug-"), "state.sqlite");
    const repository = new PersonaRepository({ path: dbPath });
    const create = (idempotencyKey: string) =>
      repository.create({
        slug: "lucy",
        displayName: "Lucy",
        description: "",
        primaryAgentId: "main",
        allowedDelegateAgentIds: [],
        revision: content,
        actorId: "device:test",
        authorId: "device:test",
        reason: "Initial revision",
        idempotencyKey,
        configuredAgentIds: agents,
      });
    create("create-lucy");

    expect(() => create("duplicate-lucy")).toThrow(
      new PersonaConflictError("Persona slug is already in use: lucy"),
    );
  });

  it("replays idempotent nested requests regardless of object key order", () => {
    const dbPath = path.join(makeTempDir(dirs, "personas-idempotency-"), "state.sqlite");
    const repository = new PersonaRepository({ path: dbPath });
    const first = repository.create({
      slug: "lucy",
      displayName: "Lucy",
      description: "",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision: content,
      actorId: "device:test",
      authorId: "device:test",
      reason: "Initial revision",
      idempotencyKey: "create-lucy",
      configuredAgentIds: agents,
    });
    const reordered = repository.create({
      slug: "lucy",
      displayName: "Lucy",
      description: "",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision: {
        traits: {
          formality: 0.4,
          playfulness: 0.2,
          directness: 0.7,
          warmth: 0.8,
        },
        behaviorGuidance: "Ask only when authority is required.",
        communicationStyle: "Clear and concise.",
        relationship: "A trusted working partner.",
        identity: "A careful collaborator.",
      },
      actorId: "device:test",
      authorId: "device:test",
      reason: "Initial revision",
      idempotencyKey: "create-lucy",
      configuredAgentIds: agents,
    });

    expect(reordered).toEqual(first);
    expect(repository.listRevisions(first.personaId)).toHaveLength(1);
  });
});
