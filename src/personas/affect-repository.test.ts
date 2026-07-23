import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { PersonaAffectRepository } from "./affect-repository.js";
import { PersonaRepository } from "./repository.js";

const agents = new Set(["main"]);
const revision = {
  identity: "Lucy",
  relationship: "Trusted collaborator",
  communicationStyle: "Clear and warm",
  behaviorGuidance: "Preserve user intent",
  traits: { warmth: 0.7, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PersonaAffectRepository", () => {
  it("persists manual impulses and accepts an allowlisted experiment as a new revision", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-persona-affect-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "state.sqlite");
    let now = 100;
    const personas = new PersonaRepository({ path: dbPath, now: () => now });
    const affect = new PersonaAffectRepository({ path: dbPath, now: () => now });
    const persona = personas.create({
      slug: "lucy",
      displayName: "Lucy",
      description: "Companion",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision,
      actorId: "operator",
      authorId: "operator",
      reason: "Initial revision",
      idempotencyKey: "create-lucy",
      configuredAgentIds: agents,
    });

    const applied = affect.appendImpulse({
      personaId: persona.personaId,
      operation: "apply",
      dimension: "energy",
      delta: 1_000,
      halfLifeMs: 3_600_000,
      reason: "manual_override",
      source: "operator",
      evidence: [{ kind: "operator_observation", referenceId: "observation-1" }],
      expiresAt: 10_000,
      actorId: "operator",
      idempotencyKey: "affect-1",
    });
    expect(applied.affect.values.energy).toBe(6_000);

    now = 200;
    const corrected = affect.appendImpulse({
      personaId: persona.personaId,
      operation: "retract",
      targetImpulseId: applied.impulse.impulseId,
      reason: "owner_correction",
      source: "operator",
      evidence: [{ kind: "operator_observation", referenceId: "correction-1" }],
      actorId: "operator",
      idempotencyKey: "affect-2",
    });
    expect(corrected.affect.values.energy).toBe(corrected.affect.baseline.energy);

    const hypothesis = "A".repeat(500);
    const proposal = affect.proposeExperiment({
      personaId: persona.personaId,
      hypothesis,
      patch: { traits: { warmth: 0.85 } },
      evidence: [{ kind: "repeated_clarification", referenceId: "clarification-rate-1" }],
      proposerId: "operator",
      idempotencyKey: "experiment-1",
    });
    const accepted = affect.acceptExperiment({
      personaId: persona.personaId,
      experimentId: proposal.experimentId,
      expectedRevision: persona.recordRevision,
      idempotencyKey: "accept-experiment-1",
      actorId: "operator",
      configuredAgentIds: agents,
    });
    expect(accepted.experiment.status).toBe("accepted");
    expect(accepted.revision.reason).toHaveLength(500);
    expect(accepted.revision.content.traits.warmth).toBe(0.85);
    expect(accepted.revision.content.behaviorGuidance).toBe(revision.behaviorGuidance);
    expect(personas.getRevision(persona.activeRevisionId).content.traits.warmth).toBe(0.7);
  });

  it("rolls back the revision when accepting an experiment fails", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-persona-affect-rollback-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "state.sqlite");
    const personas = new PersonaRepository({ path: dbPath });
    const affect = new PersonaAffectRepository({ path: dbPath });
    const persona = personas.create({
      slug: "lucy-rollback",
      displayName: "Lucy",
      description: "Companion",
      primaryAgentId: "main",
      allowedDelegateAgentIds: [],
      revision,
      actorId: "operator",
      authorId: "operator",
      reason: "Initial revision",
      idempotencyKey: "create-lucy-rollback",
      configuredAgentIds: agents,
    });
    const proposal = affect.proposeExperiment({
      personaId: persona.personaId,
      hypothesis: "A warmer tone reduces repeated clarification.",
      patch: { traits: { warmth: 0.85 } },
      evidence: [{ kind: "repeated_clarification", referenceId: "clarification-rate-1" }],
      proposerId: "operator",
      idempotencyKey: "experiment-rollback",
    });
    openOpenClawStateDatabase({ path: dbPath }).db.exec(`
      CREATE TEMP TRIGGER fail_persona_experiment_acceptance
      BEFORE UPDATE ON persona_experiments
      BEGIN
        SELECT RAISE(ABORT, 'forced experiment acceptance failure');
      END
    `);

    expect(() =>
      affect.acceptExperiment({
        personaId: persona.personaId,
        experimentId: proposal.experimentId,
        expectedRevision: persona.recordRevision,
        idempotencyKey: "accept-experiment-rollback",
        actorId: "operator",
        configuredAgentIds: agents,
      }),
    ).toThrow("forced experiment acceptance failure");

    const unchanged = personas.get(persona.personaId, agents);
    expect(unchanged.activeRevisionId).toBe(persona.activeRevisionId);
    expect(unchanged.recordRevision).toBe(persona.recordRevision);
    expect(personas.listRevisions(persona.personaId)).toHaveLength(1);
  });
});
