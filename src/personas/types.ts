import type { SpeechExpressionIntent } from "../tts/provider-types.js";

export const PERSONA_STATUSES = ["active", "archived"] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export type PersonaTraits = {
  warmth: number;
  directness: number;
  playfulness: number;
  formality: number;
};

export const PERSONA_AFFECT_DIMENSIONS = ["energy", "focus", "warmth", "playfulness"] as const;
export type PersonaAffectDimension = (typeof PERSONA_AFFECT_DIMENSIONS)[number];
export type PersonaAffectVector = Record<PersonaAffectDimension, number>;

export type PersonaAffectProfile = {
  baseline: PersonaAffectVector;
  halfLivesMs: PersonaAffectVector;
  expression: SpeechExpressionIntent;
};

export type PersonaRevisionContent = {
  identity: string;
  relationship: string;
  communicationStyle: string;
  behaviorGuidance: string;
  traits: PersonaTraits;
  affect?: PersonaAffectProfile;
};

export const PERSONA_AFFECT_EVIDENCE_KINDS = [
  "explicit_feedback",
  "interaction",
  "operator_observation",
] as const;
export type PersonaAffectEvidenceKind = (typeof PERSONA_AFFECT_EVIDENCE_KINDS)[number];

export type PersonaAffectEvidence = {
  kind: PersonaAffectEvidenceKind;
  referenceId: string;
};

export type PersonaAffectImpulse = {
  sequence: number;
  impulseId: string;
  personaId: string;
  personaRevisionId: string;
  operation: "apply" | "retract";
  targetImpulseId?: string;
  dimension?: PersonaAffectDimension;
  delta?: number;
  halfLifeMs?: number;
  reason: "interaction" | "time_rhythm" | "manual_override" | "owner_correction";
  actorId: string;
  source: "assistant" | "operator";
  evidence: PersonaAffectEvidence[];
  createdAt: number;
  expiresAt?: number;
};

export type PersonaAffectProjection = {
  tone: "calm" | "focused" | "warm" | "bright";
  pacing: "slow" | "steady" | "brisk";
  ttsExpression: SpeechExpressionIntent;
  airiExpression: "emotion.neutral" | "emotion.curious" | "emotion.concerned" | "emotion.sleepy";
};

export type PersonaAffectSnapshot = {
  personaId: string;
  personaRevisionId: string;
  evaluatedAt: number;
  baseline: PersonaAffectVector;
  values: PersonaAffectVector;
  impulseLogDigest: string;
  projection: PersonaAffectProjection;
  recentImpulses: PersonaAffectImpulse[];
};

export const PERSONA_EXPERIMENT_EVIDENCE_KINDS = [
  "explicit_feedback",
  "interruption_or_correction_rate",
  "response_completion",
  "repeated_clarification",
  "task_success",
] as const;
export type PersonaExperimentEvidenceKind = (typeof PERSONA_EXPERIMENT_EVIDENCE_KINDS)[number];

export type PersonaExperimentPatch = {
  traits?: Partial<PersonaTraits>;
  expression?: Partial<SpeechExpressionIntent>;
};

export type PersonaExperimentProposal = {
  experimentId: string;
  personaId: string;
  baseRevisionId: string;
  status: "proposed" | "accepted";
  hypothesis: string;
  patch: PersonaExperimentPatch;
  evidence: Array<{ kind: PersonaExperimentEvidenceKind; referenceId: string }>;
  proposerId: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  acceptedRevisionId?: string;
};

export type PersonaRevision = {
  revisionId: string;
  personaId: string;
  revisionNumber: number;
  parentRevisionId?: string;
  content: PersonaRevisionContent;
  authorId: string;
  reason: string;
  provenance?: string;
  createdAt: number;
};

export type PersonaEmbodimentRefs = {
  characterRef?: string;
  modelRef?: string;
  sceneRef?: string;
  expressionMapRef?: string;
  manifestRef?: string;
  animationPaletteRef?: string;
};

export type PersonaEmbodimentBinding =
  | { status: "unbound" }
  | ({ status: "bound" } & PersonaEmbodimentRefs);

export type Persona = {
  personaId: string;
  slug: string;
  displayName: string;
  description: string;
  status: PersonaStatus;
  primaryAgentId: string;
  allowedDelegateAgentIds: string[];
  activeRevisionId: string;
  recordRevision: number;
  createdAt: number;
  updatedAt: number;
  missingAgentIds: string[];
  ttsPersonaId?: string;
  embodimentBinding: PersonaEmbodimentBinding;
};

export type PersonaSelection = {
  sessionKey: string;
  personaId: string;
  recordRevision: number;
  createdAt: number;
  updatedAt: number;
};

export type PersonaTransitionAction =
  | "create"
  | "update"
  | "revise"
  | "archive"
  | "restore"
  | "delete"
  | "selection_set"
  | "selection_clear";

export type PersonaTransition = {
  sequence: number;
  transitionId: string;
  personaId: string;
  action: PersonaTransitionAction;
  actorId: string;
  requestHash: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: number;
};

export class PersonaNotFoundError extends Error {}
export class PersonaConflictError extends Error {}
export class PersonaValidationError extends Error {}
