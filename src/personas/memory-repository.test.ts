import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { PersonaMemoryRepository } from "./memory-repository.js";
import { PersonaMemoryConflictError } from "./memory-types.js";
import { PersonaRepository } from "./repository.js";

const dirs: string[] = [];
afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("PersonaMemoryRepository", () => {
  it("persists governed current memory with immutable CAS correction history", () => {
    const dbPath = path.join(makeTempDir(dirs, "persona-memory-"), "state.sqlite");
    const persona = new PersonaRepository({ path: dbPath, now: () => 100 }).create({
      slug: "lucy",
      displayName: "Lucy",
      description: "",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision: {
        identity: "Lucy",
        relationship: "Collaborator",
        communicationStyle: "Clear",
        behaviorGuidance: "Preserve intent",
        traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
      },
      actorId: "device:test",
      authorId: "device:test",
      reason: "create",
      idempotencyKey: "persona-create",
      configuredAgentIds: new Set(["main"]),
    });
    const repository = new PersonaMemoryRepository({ path: dbPath, now: () => 200 });
    const created = repository.create(persona.personaId, {
      key: "favorite-color",
      content: "Blue",
      provenance: {
        actorId: "assistant:main",
        sessionKey: "agent:main:main",
        runId: "run-1",
        source: "assistant",
      },
      confidence: 0.9,
      sensitivity: "normal",
      conflictStatus: "conflicted",
      reason: "remember",
      idempotencyKey: "remember-1",
    });
    const corrected = repository.correct(persona.personaId, created.recordId, 1, {
      key: created.key,
      content: "Green",
      provenance: { actorId: "device:test", source: "operator" },
      confidence: 1,
      sensitivity: "normal",
      conflictStatus: "clear",
      reason: "operator correction",
      idempotencyKey: "correct-1",
    });

    expect(corrected).toMatchObject({
      content: "Green",
      recordRevision: 2,
      conflictStatus: "clear",
    });
    expect(repository.listRevisions(created.recordId).map((revision) => revision.content)).toEqual([
      "Green",
      "Blue",
    ]);
    expect(repository.exportJson(persona.personaId)).toContain('"revisions"');
    expect(() =>
      repository.correct(persona.personaId, created.recordId, 1, {
        key: created.key,
        content: "Red",
        provenance: { actorId: "device:test", source: "operator" },
        confidence: 1,
        sensitivity: "normal",
        reason: "stale",
        idempotencyKey: "correct-stale",
      }),
    ).toThrow(PersonaMemoryConflictError);
  });

  it("hard-deletes with CAS and replays the same idempotency key", () => {
    const dbPath = path.join(makeTempDir(dirs, "persona-memory-delete-"), "state.sqlite");
    const persona = new PersonaRepository({ path: dbPath }).create({
      slug: "keeper",
      displayName: "Keeper",
      description: "",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision: {
        identity: "Keeper",
        relationship: "Collaborator",
        communicationStyle: "Clear",
        behaviorGuidance: "Preserve intent",
        traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
      },
      actorId: "device:test",
      authorId: "device:test",
      reason: "create",
      idempotencyKey: "persona-create",
      configuredAgentIds: new Set(["main"]),
    });
    const repository = new PersonaMemoryRepository({ path: dbPath });
    const memory = repository.create(persona.personaId, {
      key: "temporary",
      content: "Delete me",
      provenance: { actorId: "device:test", source: "operator" },
      confidence: 1,
      sensitivity: "normal",
      reason: "create",
      idempotencyKey: "create-memory",
    });

    expect(repository.delete(persona.personaId, memory.recordId, 1, "delete-memory")).toEqual({
      deleted: true,
      recordId: memory.recordId,
    });
    expect(repository.delete(persona.personaId, memory.recordId, 1, "delete-memory")).toEqual({
      deleted: true,
      recordId: memory.recordId,
    });
    expect(repository.list(persona.personaId)).toEqual([]);
  });
});
