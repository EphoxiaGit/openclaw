export const PERSONA_MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
export type PersonaMemorySensitivity = (typeof PERSONA_MEMORY_SENSITIVITIES)[number];

export const PERSONA_MEMORY_CONFLICT_STATUSES = ["clear", "conflicted"] as const;
export type PersonaMemoryConflictStatus = (typeof PERSONA_MEMORY_CONFLICT_STATUSES)[number];

export type PersonaMemoryProvenance = {
  actorId: string;
  sessionKey?: string;
  runId?: string;
  source: "assistant" | "operator";
};

export type PersonaMemoryRecord = {
  recordId: string;
  personaId: string;
  key: string;
  content: string;
  provenance: PersonaMemoryProvenance;
  confidence: number;
  sensitivity: PersonaMemorySensitivity;
  validFrom: number;
  validUntil?: number;
  expiresAt?: number;
  conflictStatus: PersonaMemoryConflictStatus;
  recordRevision: number;
  currentRevisionId: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonaMemoryRevision = {
  revisionId: string;
  recordId: string;
  revisionNumber: number;
  content: string;
  provenance: PersonaMemoryProvenance;
  confidence: number;
  sensitivity: PersonaMemorySensitivity;
  validFrom: number;
  validUntil?: number;
  expiresAt?: number;
  conflictStatus: PersonaMemoryConflictStatus;
  reason: string;
  createdAt: number;
};

export class PersonaMemoryNotFoundError extends Error {}
export class PersonaMemoryConflictError extends Error {}
export class PersonaMemoryValidationError extends Error {}
