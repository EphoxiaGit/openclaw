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
const AffectDimensionSchema = Type.Union([
  Type.Literal("energy"),
  Type.Literal("focus"),
  Type.Literal("warmth"),
  Type.Literal("playfulness"),
]);
const AffectVectorSchema = Type.Object(
  {
    energy: Type.Integer({ minimum: 0, maximum: 10_000 }),
    focus: Type.Integer({ minimum: 0, maximum: 10_000 }),
    warmth: Type.Integer({ minimum: 0, maximum: 10_000 }),
    playfulness: Type.Integer({ minimum: 0, maximum: 10_000 }),
  },
  { additionalProperties: false },
);
const AffectHalfLivesSchema = Type.Object(
  {
    energy: Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 }),
    focus: Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 }),
    warmth: Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 }),
    playfulness: Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 }),
  },
  { additionalProperties: false },
);
const SpeechExpressionSchema = Type.Object(
  {
    energy: Type.Integer({ minimum: 0, maximum: 10_000 }),
    warmth: Type.Integer({ minimum: 0, maximum: 10_000 }),
    urgency: Type.Integer({ minimum: 0, maximum: 10_000 }),
    pace: Type.Integer({ minimum: 0, maximum: 10_000 }),
    emphasis: Type.Integer({ minimum: 0, maximum: 10_000 }),
    playfulness: Type.Integer({ minimum: 0, maximum: 10_000 }),
  },
  { additionalProperties: false },
);
const AffectProfileSchema = Type.Object(
  {
    baseline: AffectVectorSchema,
    halfLivesMs: AffectHalfLivesSchema,
    expression: SpeechExpressionSchema,
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
    affect: Type.Optional(AffectProfileSchema),
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
const AffectEvidenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("explicit_feedback"),
      Type.Literal("interaction"),
      Type.Literal("operator_observation"),
    ]),
    referenceId: Id,
  },
  { additionalProperties: false },
);
const AffectImpulseSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    impulseId: Id,
    personaId: Id,
    personaRevisionId: Id,
    operation: Type.Union([Type.Literal("apply"), Type.Literal("retract")]),
    targetImpulseId: Type.Optional(Id),
    dimension: Type.Optional(AffectDimensionSchema),
    delta: Type.Optional(Type.Integer({ minimum: -10_000, maximum: 10_000 })),
    halfLifeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 })),
    reason: Type.Union([
      Type.Literal("interaction"),
      Type.Literal("time_rhythm"),
      Type.Literal("manual_override"),
      Type.Literal("owner_correction"),
    ]),
    actorId: NonEmptyString,
    source: Type.Union([Type.Literal("assistant"), Type.Literal("operator")]),
    evidence: Type.Array(AffectEvidenceSchema, { minItems: 1, maxItems: 16 }),
    createdAt: Type.Integer({ minimum: 0 }),
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const PersonaAffectSnapshotSchema = Type.Object(
  {
    personaId: Id,
    personaRevisionId: Id,
    evaluatedAt: Type.Integer({ minimum: 0 }),
    baseline: AffectVectorSchema,
    values: AffectVectorSchema,
    impulseLogDigest: Type.String({ minLength: 64, maxLength: 64 }),
    projection: Type.Object(
      {
        tone: Type.Union([
          Type.Literal("calm"),
          Type.Literal("focused"),
          Type.Literal("warm"),
          Type.Literal("bright"),
        ]),
        pacing: Type.Union([Type.Literal("slow"), Type.Literal("steady"), Type.Literal("brisk")]),
        ttsExpression: SpeechExpressionSchema,
        airiExpression: Type.Union([
          Type.Literal("emotion.neutral"),
          Type.Literal("emotion.curious"),
          Type.Literal("emotion.concerned"),
          Type.Literal("emotion.sleepy"),
        ]),
      },
      { additionalProperties: false },
    ),
    recentImpulses: Type.Array(AffectImpulseSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);
const PersonaExperimentEvidenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("explicit_feedback"),
      Type.Literal("interruption_or_correction_rate"),
      Type.Literal("response_completion"),
      Type.Literal("repeated_clarification"),
      Type.Literal("task_success"),
    ]),
    referenceId: Id,
  },
  { additionalProperties: false },
);
const PersonaExperimentPatchSchema = Type.Object(
  {
    traits: Type.Optional(Type.Partial(Traits)),
    expression: Type.Optional(Type.Partial(SpeechExpressionSchema)),
  },
  { additionalProperties: false, minProperties: 1 },
);
const PersonaExperimentProposalSchema = Type.Object(
  {
    experimentId: Id,
    personaId: Id,
    baseRevisionId: Id,
    status: Type.Union([Type.Literal("proposed"), Type.Literal("accepted")]),
    hypothesis: Type.String({ minLength: 1, maxLength: 500 }),
    patch: PersonaExperimentPatchSchema,
    evidence: Type.Array(PersonaExperimentEvidenceSchema, { minItems: 1, maxItems: 16 }),
    proposerId: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    decidedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    decidedBy: Type.Optional(NonEmptyString),
    acceptedRevisionId: Type.Optional(Id),
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
    affect: Type.Optional(PersonaAffectSnapshotSchema),
    experiments: Type.Optional(Type.Array(PersonaExperimentProposalSchema, { maxItems: 1_000 })),
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
export const PersonasAffectImpulseParamsSchema = Type.Union([
  Type.Object(
    {
      personaId: Id,
      operation: Type.Literal("apply"),
      dimension: AffectDimensionSchema,
      delta: Type.Integer({ minimum: -10_000, maximum: 10_000 }),
      halfLifeMs: Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 }),
      expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
      reason: Type.Union([
        Type.Literal("interaction"),
        Type.Literal("time_rhythm"),
        Type.Literal("manual_override"),
      ]),
      evidence: Type.Array(AffectEvidenceSchema, { minItems: 1, maxItems: 16 }),
      idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      personaId: Id,
      operation: Type.Literal("retract"),
      targetImpulseId: Id,
      reason: Type.Literal("owner_correction"),
      evidence: Type.Array(AffectEvidenceSchema, { minItems: 1, maxItems: 16 }),
      idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
]);
export const PersonasAffectImpulseResultSchema = Type.Object(
  {
    impulse: AffectImpulseSchema,
    affect: PersonaAffectSnapshotSchema,
  },
  { additionalProperties: false },
);
export const PersonasExperimentsProposeParamsSchema = Type.Object(
  {
    personaId: Id,
    hypothesis: Type.String({ minLength: 1, maxLength: 500 }),
    patch: PersonaExperimentPatchSchema,
    evidence: Type.Array(PersonaExperimentEvidenceSchema, { minItems: 1, maxItems: 16 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const PersonasExperimentsProposeResultSchema = Type.Object(
  { experiment: PersonaExperimentProposalSchema },
  { additionalProperties: false },
);
export const PersonasExperimentsAcceptParamsSchema = Type.Object(
  {
    ...MutateBase,
    experimentId: Id,
  },
  { additionalProperties: false },
);
export const PersonasExperimentsAcceptResultSchema = Type.Object(
  {
    persona: PersonaSchema,
    revision: RevisionSchema,
    experiment: PersonaExperimentProposalSchema,
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
export type PersonasAffectImpulseParams = Static<typeof PersonasAffectImpulseParamsSchema>;
export type PersonasExperimentsProposeParams = Static<
  typeof PersonasExperimentsProposeParamsSchema
>;
export type PersonasExperimentsAcceptParams = Static<typeof PersonasExperimentsAcceptParamsSchema>;
export type PersonasMemoryListResult = Static<typeof PersonasMemoryListResultSchema>;
export type PersonasMemoryCreateParams = Static<typeof PersonasMemoryCreateParamsSchema>;
export type PersonasCognitionListResult = Static<typeof PersonasCognitionListResultSchema>;
export type PersonasCognitionStartParams = Static<typeof PersonasCognitionStartParamsSchema>;
export type PersonaChangedEvent = Static<typeof PersonaChangedEventSchema>;
export type PersonaSelectionChangedEvent = Static<typeof PersonaSelectionChangedEventSchema>;
