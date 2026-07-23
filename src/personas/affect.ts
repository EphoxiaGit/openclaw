import { createHash } from "node:crypto";
import type { SpeechExpressionIntent } from "../tts/provider-types.js";
import {
  PERSONA_AFFECT_DIMENSIONS,
  type PersonaAffectImpulse,
  type PersonaAffectProfile,
  type PersonaAffectProjection,
  type PersonaAffectSnapshot,
  type PersonaAffectVector,
  type PersonaExperimentPatch,
  type PersonaRevisionContent,
} from "./types.js";
import { PersonaValidationError } from "./types.js";

const BASIS_POINTS_MAX = 10_000;
const MIN_HALF_LIFE_MS = 1_000;
const MAX_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_HALF_LIFE_MS = 4 * 60 * 60 * 1_000;

function clamp(value: number): number {
  return Math.min(BASIS_POINTS_MAX, Math.max(0, Math.round(value)));
}

function vector(value: number): PersonaAffectVector {
  return Object.fromEntries(
    PERSONA_AFFECT_DIMENSIONS.map((dimension) => [dimension, value]),
  ) as PersonaAffectVector;
}

function validateBasisPoints(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > BASIS_POINTS_MAX) {
    throw new PersonaValidationError(`${label} must be an integer between 0 and 10000`);
  }
  return value;
}

function validateVector(
  value: PersonaAffectVector,
  label: string,
  validate: (entry: number, entryLabel: string) => number,
): PersonaAffectVector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaValidationError(`${label} must be an object`);
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== [...PERSONA_AFFECT_DIMENSIONS].toSorted().join(",")) {
    throw new PersonaValidationError(`${label} contains unknown or missing dimensions`);
  }
  return Object.fromEntries(
    PERSONA_AFFECT_DIMENSIONS.map((dimension) => [
      dimension,
      validate(value[dimension], `${label}.${dimension}`),
    ]),
  ) as PersonaAffectVector;
}

function validateExpression(value: SpeechExpressionIntent): SpeechExpressionIntent {
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "emphasis,energy,pace,playfulness,urgency,warmth") {
    throw new PersonaValidationError("affect.expression contains unknown or missing fields");
  }
  return Object.freeze({
    energy: validateBasisPoints(value.energy, "affect.expression.energy"),
    warmth: validateBasisPoints(value.warmth, "affect.expression.warmth"),
    urgency: validateBasisPoints(value.urgency, "affect.expression.urgency"),
    pace: validateBasisPoints(value.pace, "affect.expression.pace"),
    emphasis: validateBasisPoints(value.emphasis, "affect.expression.emphasis"),
    playfulness: validateBasisPoints(value.playfulness, "affect.expression.playfulness"),
  });
}

export function defaultPersonaAffectProfile(content: PersonaRevisionContent): PersonaAffectProfile {
  const baseline = vector(5_000);
  baseline.focus = clamp(content.traits.directness * BASIS_POINTS_MAX);
  baseline.warmth = clamp(content.traits.warmth * BASIS_POINTS_MAX);
  baseline.playfulness = clamp(content.traits.playfulness * BASIS_POINTS_MAX);
  return {
    baseline,
    halfLivesMs: vector(DEFAULT_HALF_LIFE_MS),
    expression: {
      energy: 5_000,
      warmth: clamp(content.traits.warmth * BASIS_POINTS_MAX),
      urgency: 2_500,
      pace: 5_000,
      emphasis: 5_000,
      playfulness: baseline.playfulness,
    },
  };
}

export function validatePersonaAffectProfile(value: PersonaAffectProfile): PersonaAffectProfile {
  const keys = Object.keys(value ?? {}).toSorted();
  if (keys.join(",") !== "baseline,expression,halfLivesMs") {
    throw new PersonaValidationError("affect contains unknown or missing fields");
  }
  return {
    baseline: validateVector(value.baseline, "affect.baseline", validateBasisPoints),
    halfLivesMs: validateVector(value.halfLivesMs, "affect.halfLivesMs", (entry, label) => {
      if (!Number.isSafeInteger(entry) || entry < MIN_HALF_LIFE_MS || entry > MAX_HALF_LIFE_MS) {
        throw new PersonaValidationError(
          `${label} must be an integer between ${MIN_HALF_LIFE_MS} and ${MAX_HALF_LIFE_MS}`,
        );
      }
      return entry;
    }),
    expression: validateExpression(value.expression),
  };
}

export function validatePersonaExperimentPatch(
  patch: PersonaExperimentPatch,
): PersonaExperimentPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new PersonaValidationError("experiment patch must be an object");
  }
  const unknown = Object.keys(patch).find((key) => key !== "traits" && key !== "expression");
  if (unknown) {
    throw new PersonaValidationError(`experiment patch field is not allowlisted: ${unknown}`);
  }
  const traits = patch.traits
    ? Object.fromEntries(
        Object.entries(patch.traits).map(([key, value]) => {
          if (!["warmth", "directness", "playfulness", "formality"].includes(key)) {
            throw new PersonaValidationError(`experiment trait is not allowlisted: ${key}`);
          }
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new PersonaValidationError(`experiment trait ${key} must be between 0 and 1`);
          }
          return [key, value];
        }),
      )
    : undefined;
  const expression = patch.expression
    ? Object.fromEntries(
        Object.entries(patch.expression).map(([key, value]) => {
          if (!["energy", "warmth", "urgency", "pace", "emphasis", "playfulness"].includes(key)) {
            throw new PersonaValidationError(`experiment expression is not allowlisted: ${key}`);
          }
          return [key, validateBasisPoints(value, `experiment expression ${key}`)];
        }),
      )
    : undefined;
  if (!traits && !expression) {
    throw new PersonaValidationError("experiment patch must not be empty");
  }
  return {
    ...(traits ? { traits } : {}),
    ...(expression ? { expression } : {}),
  };
}

export function applyPersonaExperimentPatch(
  content: PersonaRevisionContent,
  patch: PersonaExperimentPatch,
): PersonaRevisionContent {
  const validated = validatePersonaExperimentPatch(patch);
  const traits = { ...content.traits, ...validated.traits };
  const profile = content.affect ?? defaultPersonaAffectProfile({ ...content, traits });
  const baseline = { ...profile.baseline };
  if (validated.traits?.directness !== undefined) {
    baseline.focus = clamp(traits.directness * BASIS_POINTS_MAX);
  }
  if (validated.traits?.warmth !== undefined) {
    baseline.warmth = clamp(traits.warmth * BASIS_POINTS_MAX);
  }
  if (validated.traits?.playfulness !== undefined) {
    baseline.playfulness = clamp(traits.playfulness * BASIS_POINTS_MAX);
  }
  return {
    ...content,
    traits,
    affect: {
      ...profile,
      baseline,
      expression: { ...profile.expression, ...validated.expression },
    },
  };
}

function digest(impulses: readonly PersonaAffectImpulse[]): string {
  return createHash("sha256").update(JSON.stringify(impulses)).digest("hex");
}

function project(
  values: PersonaAffectVector,
  profile: PersonaAffectProfile,
): PersonaAffectProjection {
  const tone =
    values.focus >= 7_000
      ? "focused"
      : values.warmth >= 7_000
        ? "warm"
        : values.playfulness >= 7_000
          ? "bright"
          : "calm";
  const pacing = values.energy >= 7_000 ? "brisk" : values.energy <= 3_000 ? "slow" : "steady";
  const airiExpression =
    values.energy <= 2_500
      ? "emotion.sleepy"
      : values.focus >= 7_000
        ? "emotion.curious"
        : values.warmth <= 2_500
          ? "emotion.concerned"
          : "emotion.neutral";
  return {
    tone,
    pacing,
    ttsExpression: {
      ...profile.expression,
      energy: clamp(profile.expression.energy + (values.energy - profile.baseline.energy)),
      warmth: clamp(profile.expression.warmth + (values.warmth - profile.baseline.warmth)),
      urgency: clamp(profile.expression.urgency + (values.focus - profile.baseline.focus) / 2),
      pace: clamp(profile.expression.pace + (values.energy - profile.baseline.energy) / 2),
      emphasis: clamp(profile.expression.emphasis + (values.focus - profile.baseline.focus) / 2),
      playfulness: clamp(
        profile.expression.playfulness + (values.playfulness - profile.baseline.playfulness),
      ),
    },
    airiExpression,
  };
}

export function derivePersonaAffectSnapshot(input: {
  personaId: string;
  personaRevisionId: string;
  content: PersonaRevisionContent;
  impulses: readonly PersonaAffectImpulse[];
  evaluatedAt: number;
}): PersonaAffectSnapshot {
  if (!Number.isSafeInteger(input.evaluatedAt) || input.evaluatedAt < 0) {
    throw new PersonaValidationError("evaluatedAt must be a non-negative integer");
  }
  const profile = input.content.affect
    ? validatePersonaAffectProfile(input.content.affect)
    : defaultPersonaAffectProfile(input.content);
  const impulses = [...input.impulses].toSorted(
    (left, right) =>
      left.sequence - right.sequence || left.impulseId.localeCompare(right.impulseId),
  );
  const retracted = new Set(
    impulses
      .filter((impulse) => impulse.operation === "retract")
      .map((impulse) => impulse.targetImpulseId)
      .filter((value): value is string => Boolean(value)),
  );
  const values = Object.fromEntries(
    PERSONA_AFFECT_DIMENSIONS.map((dimension) => {
      let offset = 0;
      for (const impulse of impulses) {
        if (
          impulse.operation !== "apply" ||
          impulse.dimension !== dimension ||
          impulse.personaId !== input.personaId ||
          impulse.personaRevisionId !== input.personaRevisionId ||
          retracted.has(impulse.impulseId) ||
          impulse.createdAt > input.evaluatedAt ||
          (impulse.expiresAt !== undefined && impulse.expiresAt <= input.evaluatedAt)
        ) {
          continue;
        }
        const elapsed = input.evaluatedAt - impulse.createdAt;
        offset += (impulse.delta ?? 0) * 2 ** (-elapsed / (impulse.halfLifeMs ?? 1));
      }
      return [dimension, clamp(profile.baseline[dimension] + offset)];
    }),
  ) as PersonaAffectVector;
  return {
    personaId: input.personaId,
    personaRevisionId: input.personaRevisionId,
    evaluatedAt: input.evaluatedAt,
    baseline: profile.baseline,
    values,
    impulseLogDigest: digest(impulses),
    projection: project(values, profile),
    recentImpulses: impulses.slice(-50).toReversed(),
  };
}
