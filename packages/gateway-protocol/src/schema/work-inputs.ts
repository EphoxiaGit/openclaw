import { Type, type Static } from "typebox";
import { NonEmptyString, SecretRefSchema } from "./primitives.js";

const Id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const Common = {
  id: Id,
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("resolved"),
    Type.Literal("cancelled"),
    Type.Literal("expired"),
  ]),
  sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
  projectId: Type.Optional(Id),
  planId: Type.Optional(Id),
  stepId: Type.Optional(Id),
  taskId: Type.Optional(Id),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  expiresAt: Type.Optional(Type.Integer()),
  prompt: Type.String({ minLength: 1, maxLength: 2_000 }),
  description: Type.Optional(Type.String({ maxLength: 4_000 })),
  creator: Type.Object(
    { type: Type.Union([Type.Literal("system"), Type.Literal("agent")]), label: NonEmptyString },
    { additionalProperties: false },
  ),
};
const Choice = Type.Object(
  { id: Id, label: Type.String({ minLength: 1, maxLength: 240 }) },
  { additionalProperties: false },
);

export const WorkInputRequestSchema = Type.Union([
  Type.Object(
    {
      ...Common,
      kind: Type.Literal("question"),
      options: Type.Array(Choice, { maxItems: 20 }),
      allowMultiple: Type.Boolean(),
      allowFreeText: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...Common,
      kind: Type.Literal("add_information"),
      allowedFields: Type.Array(
        Type.Union([Type.Literal("text"), Type.Literal("fileRefs"), Type.Literal("artifactRefs")]),
        { minItems: 1, maxItems: 3, uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...Common,
      kind: Type.Literal("approval"),
      decisions: Type.Array(Type.Union([Type.Literal("approve"), Type.Literal("reject")]), {
        minItems: 2,
        maxItems: 2,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...Common,
      kind: Type.Literal("secret_ref"),
      providerAliases: Type.Optional(
        Type.Array(NonEmptyString, { maxItems: 32, uniqueItems: true }),
      ),
      targetPaths: Type.Optional(Type.Array(NonEmptyString, { maxItems: 32, uniqueItems: true })),
    },
    { additionalProperties: false },
  ),
]);

export const WorkInputResponseSchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
    choiceIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 20, uniqueItems: true })),
    fileRefs: Type.Optional(
      Type.Array(Type.Object({ id: Id }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 20,
      }),
    ),
    artifactRefs: Type.Optional(
      Type.Array(Type.Object({ artifactId: Id }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 20,
      }),
    ),
    secretRefs: Type.Optional(Type.Array(SecretRefSchema, { minItems: 1, maxItems: 20 })),
  },
  { additionalProperties: false },
);

export const WorkInputsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    projectId: Type.Optional(Id),
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("resolved"),
        Type.Literal("cancelled"),
        Type.Literal("expired"),
      ]),
    ),
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const WorkInputsListResultSchema = Type.Object(
  { requests: Type.Array(WorkInputRequestSchema), nextCursor: Type.Optional(Type.Integer()) },
  { additionalProperties: false },
);
export const WorkInputsGetParamsSchema = Type.Object(
  { requestId: Id },
  { additionalProperties: false },
);
export const WorkInputsGetResultSchema = Type.Object(
  { request: WorkInputRequestSchema, response: Type.Optional(WorkInputResponseSchema) },
  { additionalProperties: false },
);
const MutationBase = {
  requestId: Id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
};
export const WorkInputsResolveParamsSchema = Type.Object(
  { ...MutationBase, response: WorkInputResponseSchema },
  { additionalProperties: false },
);
export const WorkInputsCancelParamsSchema = Type.Object(MutationBase, {
  additionalProperties: false,
});
export const WorkInputsMutationResultSchema = WorkInputsGetResultSchema;
export const WorkInputRequestedEventSchema = Type.Object(
  { request: WorkInputRequestSchema },
  { additionalProperties: false },
);
export const WorkInputChangedEventSchema = Type.Object(
  { requestId: Id, revision: Type.Integer({ minimum: 1 }), status: Common.status },
  { additionalProperties: false },
);

export type WorkInputRequest = Static<typeof WorkInputRequestSchema>;
export type WorkInputResponse = Static<typeof WorkInputResponseSchema>;
export type WorkInputsListParams = Static<typeof WorkInputsListParamsSchema>;
export type WorkInputsResolveParams = Static<typeof WorkInputsResolveParamsSchema>;
export type WorkInputsCancelParams = Static<typeof WorkInputsCancelParamsSchema>;
