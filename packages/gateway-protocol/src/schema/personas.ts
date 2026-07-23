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
export type PersonaChangedEvent = Static<typeof PersonaChangedEventSchema>;
export type PersonaSelectionChangedEvent = Static<typeof PersonaSelectionChangedEventSchema>;
