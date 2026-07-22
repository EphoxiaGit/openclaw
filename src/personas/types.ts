export const PERSONA_STATUSES = ["active", "archived"] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export type PersonaTraits = {
  warmth: number;
  directness: number;
  playfulness: number;
  formality: number;
};

export type PersonaRevisionContent = {
  identity: string;
  relationship: string;
  communicationStyle: string;
  behaviorGuidance: string;
  traits: PersonaTraits;
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
