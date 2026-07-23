import { describe, expect, it } from "vitest";
import {
  applyPersonaExperimentPatch,
  derivePersonaAffectSnapshot,
  validatePersonaExperimentPatch,
} from "./affect.js";
import type { PersonaAffectImpulse, PersonaRevisionContent } from "./types.js";

const content: PersonaRevisionContent = {
  identity: "Lucy",
  relationship: "Trusted collaborator",
  communicationStyle: "Clear and warm",
  behaviorGuidance: "Preserve user intent",
  traits: { warmth: 0.7, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};

function impulse(
  input: Partial<PersonaAffectImpulse> & Pick<PersonaAffectImpulse, "sequence" | "impulseId">,
): PersonaAffectImpulse {
  return {
    personaId: "persona-1",
    personaRevisionId: "revision-1",
    operation: "apply",
    dimension: "energy",
    delta: 1_000,
    halfLifeMs: 3_600_000,
    reason: "interaction",
    actorId: "assistant",
    source: "assistant",
    evidence: [{ kind: "interaction", referenceId: `evidence-${input.impulseId}` }],
    createdAt: 0,
    ...input,
  };
}

describe("Persona affect", () => {
  it("merges deterministic impulses, decays once, and excludes exact expiry", () => {
    const impulses = [
      impulse({ sequence: 2, impulseId: "later", delta: -500 }),
      impulse({ sequence: 1, impulseId: "first", delta: 1_001, expiresAt: 3_600_001 }),
    ];
    const snapshot = derivePersonaAffectSnapshot({
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      content,
      impulses,
      evaluatedAt: 3_600_000,
    });
    expect(snapshot.values.energy).toBe(5_251);
    expect(snapshot.recentImpulses.map((entry) => entry.sequence)).toEqual([2, 1]);
    expect(snapshot.impulseLogDigest).toHaveLength(64);

    const expired = derivePersonaAffectSnapshot({
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      content,
      impulses,
      evaluatedAt: 3_600_001,
    });
    expect(expired.values.energy).toBe(4_750);
  });

  it("keeps owner correction retractions permanent", () => {
    const applied = impulse({ sequence: 1, impulseId: "target", delta: 2_000 });
    const correction = impulse({
      sequence: 2,
      impulseId: "correction",
      operation: "retract",
      targetImpulseId: "target",
      dimension: undefined,
      delta: undefined,
      halfLifeMs: undefined,
      reason: "owner_correction",
      actorId: "operator",
      source: "operator",
      expiresAt: 1,
    });
    const snapshot = derivePersonaAffectSnapshot({
      personaId: "persona-1",
      personaRevisionId: "revision-1",
      content,
      impulses: [applied, correction],
      evaluatedAt: 3_600_000,
    });
    expect(snapshot.values.energy).toBe(snapshot.baseline.energy);
  });

  it("projects only bounded presentation intent and allowlisted experiment fields", () => {
    const revised = applyPersonaExperimentPatch(content, {
      traits: { warmth: 0.9 },
      expression: { pace: 6_000 },
    });
    expect(revised.traits.warmth).toBe(0.9);
    expect(revised.affect?.baseline.warmth).toBe(9_000);
    expect(revised.affect?.expression.pace).toBe(6_000);
    expect(revised.behaviorGuidance).toBe(content.behaviorGuidance);
    const repeated = applyPersonaExperimentPatch(revised, {
      traits: { warmth: 0.4, directness: 0.3, playfulness: 0.8 },
    });
    expect(repeated.affect).toEqual({
      ...revised.affect,
      baseline: {
        ...revised.affect?.baseline,
        focus: 3_000,
        warmth: 4_000,
        playfulness: 8_000,
      },
    });
    expect(() => validatePersonaExperimentPatch({ provider: "forbidden" } as never)).toThrow(
      /not allowlisted/,
    );
  });
});
