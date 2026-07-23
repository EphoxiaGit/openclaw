import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const AgentId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]*$" });
const TtsPersonaId = Type.String({ minLength: 1, maxLength: 128 });
const EmbodimentRef = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});
const EmbodimentRefsSchema = Type.Object(
  {
    characterRef: Type.Optional(EmbodimentRef),
    modelRef: Type.Optional(EmbodimentRef),
    sceneRef: Type.Optional(EmbodimentRef),
    expressionMapRef: Type.Optional(EmbodimentRef),
    manifestRef: Type.Optional(EmbodimentRef),
    animationPaletteRef: Type.Optional(EmbodimentRef),
  },
  { additionalProperties: false, minProperties: 1 },
);
const EmbodimentBindingSchema = Type.Union([
  Type.Object({ status: Type.Literal("unbound") }, { additionalProperties: false }),
  Type.Object(
    { status: Type.Literal("bound"), ...EmbodimentRefsSchema.properties },
    { additionalProperties: false, minProperties: 2 },
  ),
]);
const Status = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
const VoiceBindingSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("unbound"),
      Type.Literal("missing"),
      Type.Literal("unavailable"),
      Type.Literal("ready"),
    ]),
    ttsPersonaId: Type.Optional(TtsPersonaId),
    provider: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    voice: Type.Optional(NonEmptyString),
    providerBinding: Type.Optional(Type.Union([Type.Literal("applied"), Type.Literal("missing")])),
  },
  { additionalProperties: false },
);
const Traits = Type.Object(
  {
    warmth: Type.Number({ minimum: 0, maximum: 1 }),
    directness: Type.Number({ minimum: 0, maximum: 1 }),
    playfulness: Type.Number({ minimum: 0, maximum: 1 }),
    formality: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export const PersonaRevisionContentSchema = Type.Object(
  {
    identity: Type.String({ minLength: 1, maxLength: 2_000 }),
    relationship: Type.String({ minLength: 1, maxLength: 2_000 }),
    communicationStyle: Type.String({ minLength: 1, maxLength: 2_000 }),
    behaviorGuidance: Type.String({ minLength: 1, maxLength: 4_000 }),
    traits: Traits,
  },
  { additionalProperties: false },
);
const PersonaSchema = Type.Object(
  {
    personaId: Id,
    slug: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 1_000 }),
    status: Status,
    primaryAgentId: AgentId,
    allowedDelegateAgentIds: Type.Array(AgentId, { maxItems: 16, uniqueItems: true }),
    activeRevisionId: Id,
    recordRevision: Type.Integer({ minimum: 1 }),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    missingAgentIds: Type.Array(AgentId, { maxItems: 17, uniqueItems: true }),
    voiceBinding: VoiceBindingSchema,
    embodimentBinding: EmbodimentBindingSchema,
  },
  { additionalProperties: false },
);
const RevisionSchema = Type.Object(
  {
    revisionId: Id,
    personaId: Id,
    revisionNumber: Type.Integer({ minimum: 1 }),
    parentRevisionId: Type.Optional(Id),
    content: PersonaRevisionContentSchema,
    authorId: NonEmptyString,
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    provenance: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    createdAt: Type.Integer(),
  },
  { additionalProperties: false },
);
const SelectionSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    personaId: Id,
    recordRevision: Type.Integer({ minimum: 1 }),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
  },
  { additionalProperties: false },
);
const MutateBase = {
  personaId: Id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
};
export const PersonasListParamsSchema = Type.Object(
  { includeArchived: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export const PersonasListResultSchema = Type.Object(
  { personas: Type.Array(PersonaSchema, { maxItems: 1_000 }) },
  { additionalProperties: false },
);
export const PersonasGetParamsSchema = Type.Object(
  { personaId: Id },
  { additionalProperties: false },
);
export const PersonasGetResultSchema = Type.Object(
  {
    persona: PersonaSchema,
    activeRevision: RevisionSchema,
    revisions: Type.Array(RevisionSchema, { maxItems: 1_000 }),
  },
  { additionalProperties: false },
);
export const PersonasCreateParamsSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, maxLength: 64 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 1_000 }),
    primaryAgentId: AgentId,
    allowedDelegateAgentIds: Type.Array(AgentId, { maxItems: 16, uniqueItems: true }),
    ttsPersonaId: Type.Optional(TtsPersonaId),
    embodimentBinding: Type.Optional(EmbodimentRefsSchema),
    revision: PersonaRevisionContentSchema,
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const PersonasCreateResultSchema = Type.Object(
  { persona: PersonaSchema },
  { additionalProperties: false },
);
export const PersonasUpdateParamsSchema = Type.Object(
  {
    ...MutateBase,
    metadata: Type.Optional(
      Type.Object(
        {
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          description: Type.Optional(Type.String({ maxLength: 1_000 })),
        },
        { additionalProperties: false },
      ),
    ),
    primaryAgentId: Type.Optional(AgentId),
    allowedDelegateAgentIds: Type.Optional(
      Type.Array(AgentId, { maxItems: 16, uniqueItems: true }),
    ),
    ttsPersonaId: Type.Optional(Type.Union([TtsPersonaId, Type.Null()])),
    embodimentBinding: Type.Optional(Type.Union([EmbodimentRefsSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export const PersonasUpdateResultSchema = PersonasCreateResultSchema;
export const PersonasReviseParamsSchema = Type.Object(
  {
    ...MutateBase,
    content: Type.Optional(PersonaRevisionContentSchema),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    sourceRevisionId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export const PersonasReviseResultSchema = Type.Object(
  { persona: PersonaSchema, revision: RevisionSchema },
  { additionalProperties: false },
);
export const PersonasLifecycleParamsSchema = Type.Object(MutateBase, {
  additionalProperties: false,
});
export const PersonasDeleteResultSchema = Type.Object(
  { deleted: Type.Literal(true), personaId: Id },
  { additionalProperties: false },
);
export const PersonasSelectionGetParamsSchema = Type.Object(
  { sessionKey: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export const PersonasSelectionGetResultSchema = Type.Object(
  { selection: Type.Optional(SelectionSchema) },
  { additionalProperties: false },
);
export const PersonasSelectionSetParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    personaId: Type.Optional(Id),
    expectedRevision: Type.Integer({ minimum: 0 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const PersonasSelectionSetResultSchema = PersonasSelectionGetResultSchema;
export const PersonasHistoryParamsSchema = Type.Object(
  {
    personaId: Id,
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const TransitionSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    transitionId: Id,
    personaId: Id,
    action: NonEmptyString,
    actorId: NonEmptyString,
    requestHash: Type.String({ minLength: 64, maxLength: 64 }),
    metadata: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    ),
    createdAt: Type.Integer(),
  },
  { additionalProperties: false },
);
export const PersonasHistoryResultSchema = Type.Object(
  {
    transitions: Type.Array(TransitionSchema, { maxItems: 100 }),
    nextCursor: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const PersonaMemoryProvenanceSchema = Type.Object(
  {
    actorId: NonEmptyString,
    sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    runId: Type.Optional(NonEmptyString),
    source: Type.Union([Type.Literal("assistant"), Type.Literal("operator")]),
  },
  { additionalProperties: false },
);
const PersonaMemoryRecordSchema = Type.Object(
  {
    recordId: Id,
    personaId: Id,
    key: Type.String({ minLength: 1, maxLength: 160 }),
    content: Type.String({ minLength: 1, maxLength: 8_000 }),
    provenance: PersonaMemoryProvenanceSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    sensitivity: Type.Union([Type.Literal("normal"), Type.Literal("sensitive")]),
    validFrom: Type.Integer(),
    validUntil: Type.Optional(Type.Integer()),
    expiresAt: Type.Optional(Type.Integer()),
    conflictStatus: Type.Union([Type.Literal("clear"), Type.Literal("conflicted")]),
    recordRevision: Type.Integer({ minimum: 1 }),
    currentRevisionId: Id,
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
  },
  { additionalProperties: false },
);
const PersonaMemoryWriteSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 160 }),
    content: Type.String({ minLength: 1, maxLength: 8_000 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    sensitivity: Type.Union([Type.Literal("normal"), Type.Literal("sensitive")]),
    validFrom: Type.Optional(Type.Integer()),
    validUntil: Type.Optional(Type.Integer()),
    expiresAt: Type.Optional(Type.Integer()),
    conflictStatus: Type.Optional(Type.Union([Type.Literal("clear"), Type.Literal("conflicted")])),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export const PersonasMemoryListParamsSchema = Type.Object(
  {
    personaId: Id,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    includeInvalid: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const PersonasMemoryListResultSchema = Type.Object(
  { memories: Type.Array(PersonaMemoryRecordSchema, { maxItems: 10_000 }) },
  { additionalProperties: false },
);
export const PersonasMemoryCreateParamsSchema = Type.Object(
  { personaId: Id, memory: PersonaMemoryWriteSchema },
  { additionalProperties: false },
);
export const PersonasMemoryCorrectParamsSchema = Type.Object(
  {
    personaId: Id,
    recordId: Id,
    expectedRevision: Type.Integer({ minimum: 1 }),
    memory: PersonaMemoryWriteSchema,
  },
  { additionalProperties: false },
);
export const PersonasMemoryMutationResultSchema = Type.Object(
  { memory: PersonaMemoryRecordSchema },
  { additionalProperties: false },
);
export const PersonasMemoryDeleteParamsSchema = Type.Object(
  {
    personaId: Id,
    recordId: Id,
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export const PersonasMemoryDeleteResultSchema = Type.Object(
  { deleted: Type.Literal(true), recordId: Id },
  { additionalProperties: false },
);
export const PersonasMemoryExportParamsSchema = Type.Object(
  { personaId: Id },
  { additionalProperties: false },
);
export const PersonasMemoryExportResultSchema = Type.Object(
  { filename: NonEmptyString, json: Type.String() },
  { additionalProperties: false },
);
const CognitiveOutputKindSchema = Type.Union([
  Type.Literal("memory_candidate"),
  Type.Literal("internal_memo"),
  Type.Literal("project_suggestion"),
  Type.Literal("follow_up"),
  Type.Literal("persona_experiment_proposal"),
  Type.Literal("no_op"),
]);
const CognitiveOpportunitySchema = Type.Object(
  {
    opportunityId: Id,
    personaId: Id,
    agentId: AgentId,
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    source: Type.Union([Type.Literal("explicit"), Type.Literal("scheduled")]),
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("waiting_review"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
    outputKind: Type.Optional(CognitiveOutputKindSchema),
    outputSummary: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
    taskFlowId: Type.Optional(Id),
    approvalRequestId: Type.Optional(Id),
    recordRevision: Type.Integer({ minimum: 1 }),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    completedAt: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
export const PersonasCognitionListParamsSchema = Type.Object(
  {
    personaId: Id,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const PersonasCognitionListResultSchema = Type.Object(
  { opportunities: Type.Array(CognitiveOpportunitySchema, { maxItems: 100 }) },
  { additionalProperties: false },
);
export const PersonasCognitionStartParamsSchema = Type.Object(
  {
    personaId: Id,
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    source: Type.Optional(Type.Union([Type.Literal("explicit"), Type.Literal("scheduled")])),
    output: Type.Optional(
      Type.Object(
        {
          kind: CognitiveOutputKindSchema,
          summary: Type.String({ minLength: 1, maxLength: 4_000 }),
        },
        { additionalProperties: false },
      ),
    ),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export const PersonasCognitionStartResultSchema = Type.Object(
  { opportunity: CognitiveOpportunitySchema },
  { additionalProperties: false },
);
export const PersonaChangedEventSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("revise"),
      Type.Literal("archive"),
      Type.Literal("restore"),
      Type.Literal("delete"),
    ]),
    personaId: Id,
    status: Type.Optional(Status),
    recordRevision: Type.Integer({ minimum: 1 }),
    activeRevisionId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export const PersonaSelectionChangedEventSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("set"), Type.Literal("clear")]),
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    personaId: Type.Optional(Id),
    recordRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type PersonasListParams = Static<typeof PersonasListParamsSchema>;
export type PersonasListResult = Static<typeof PersonasListResultSchema>;
export type PersonasGetParams = Static<typeof PersonasGetParamsSchema>;
export type PersonasGetResult = Static<typeof PersonasGetResultSchema>;
export type PersonasCreateParams = Static<typeof PersonasCreateParamsSchema>;
export type PersonasUpdateParams = Static<typeof PersonasUpdateParamsSchema>;
export type PersonasReviseParams = Static<typeof PersonasReviseParamsSchema>;
export type PersonasLifecycleParams = Static<typeof PersonasLifecycleParamsSchema>;
export type PersonasSelectionGetParams = Static<typeof PersonasSelectionGetParamsSchema>;
export type PersonasSelectionSetParams = Static<typeof PersonasSelectionSetParamsSchema>;
export type PersonasHistoryParams = Static<typeof PersonasHistoryParamsSchema>;
export type PersonasMemoryListResult = Static<typeof PersonasMemoryListResultSchema>;
export type PersonasMemoryCreateParams = Static<typeof PersonasMemoryCreateParamsSchema>;
export type PersonasCognitionListResult = Static<typeof PersonasCognitionListResultSchema>;
export type PersonasCognitionStartParams = Static<typeof PersonasCognitionStartParamsSchema>;
export type PersonaChangedEvent = Static<typeof PersonaChangedEventSchema>;
export type PersonaSelectionChangedEvent = Static<typeof PersonaSelectionChangedEventSchema>;
