import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  CognitiveOpportunityConflictError,
  CognitiveOpportunityRepository,
} from "./cognitive-opportunity.js";
import { PersonaRepository } from "./repository.js";

const dirs: string[] = [];

afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("CognitiveOpportunityRepository", () => {
  it("persists typed Persona opportunities with idempotency and revision CAS", () => {
    const dbPath = path.join(makeTempDir(dirs, "persona-cognition-"), "state.sqlite");
    const persona = new PersonaRepository({ path: dbPath }).create({
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
    let now = 200;
    const repository = new CognitiveOpportunityRepository({ path: dbPath, now: () => now });
    const input = {
      opportunityId: "opportunity-1",
      personaId: persona.personaId,
      agentId: "main",
      sessionKey: "agent:main:main",
      source: "explicit" as const,
      idempotencyKey: "reflect-1",
      output: { kind: "internal_memo" as const, summary: "Review the current project plan." },
    };
    const created = repository.create(input);

    expect(repository.create({ ...input, opportunityId: "ignored-replay-id" })).toEqual(created);
    expect(() =>
      repository.create({
        ...input,
        opportunityId: "opportunity-2",
        output: { kind: "no_op", summary: "Nothing to do." },
      }),
    ).toThrow(CognitiveOpportunityConflictError);

    now = 300;
    const completed = repository.update(created.opportunityId, created.recordRevision, {
      status: "completed",
      taskFlowId: "flow-1",
      output: input.output,
    });
    expect(completed).toMatchObject({
      status: "completed",
      outputKind: "internal_memo",
      outputSummary: "Review the current project plan.",
      taskFlowId: "flow-1",
      recordRevision: 2,
      completedAt: 300,
    });
    expect(repository.list(persona.personaId)).toEqual([completed]);
    expect(() =>
      repository.update(created.opportunityId, created.recordRevision, { status: "failed" }),
    ).toThrow(CognitiveOpportunityConflictError);
  });
});
