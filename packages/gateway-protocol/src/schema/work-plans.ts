import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const WorkPlanStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("review"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("superseded"),
]);
const WorkStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("review"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("cancelled"),
  Type.Literal("superseded"),
]);
const OwnerTypeSchema = Type.Union([
  Type.Literal("task"),
  Type.Literal("task_flow"),
  Type.Literal("codex"),
  Type.Literal("omx"),
  Type.Literal("worktree"),
  Type.Literal("external"),
]);
const StepSchema = Type.Object(
  {
    stepId: NonEmptyString,
    title: NonEmptyString,
    status: Type.Optional(WorkStepStatusSchema),
    dependsOn: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
  },
  { additionalProperties: false },
);
const RequirementSchema = Type.Object(
  {
    requirementId: NonEmptyString,
    text: NonEmptyString,
    disposition: Type.Union([
      Type.Literal("mapped"),
      Type.Literal("excluded"),
      Type.Literal("unresolved"),
    ]),
    mappedStepId: Type.Optional(NonEmptyString),
    exclusionReason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
const MutationSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("setPlanStatus"), status: WorkPlanStatusSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("setStepStatus"), stepId: NonEmptyString, status: WorkStepStatusSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("skipStep"), stepId: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("linkTask"),
      stepId: NonEmptyString,
      taskId: NonEmptyString,
      taskFlowId: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("retryStep"),
      stepId: NonEmptyString,
      attemptId: NonEmptyString,
      ownerType: OwnerTypeSchema,
      ownerId: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("reconcileAttempt"),
      attemptId: NonEmptyString,
      ownerState: Type.Union([
        Type.Literal("pending"),
        Type.Literal("running"),
        Type.Literal("waiting"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
        Type.Literal("lost"),
        Type.Literal("unknown"),
      ]),
      recoveryState: Type.Optional(NonEmptyString),
      stepStatus: Type.Optional(WorkStepStatusSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("splitStep"),
      stepId: NonEmptyString,
      replacementSteps: Type.Array(StepSchema, { minItems: 2 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("mergeSteps"),
      stepIds: Type.Array(NonEmptyString, { minItems: 2, uniqueItems: true }),
      replacementStep: StepSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("replan"),
      steps: Type.Array(StepSchema, { minItems: 1 }),
      requirements: Type.Array(RequirementSchema),
    },
    { additionalProperties: false },
  ),
]);

export const WorkProjectsCreateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    goalId: NonEmptyString,
    primaryConversationId: NonEmptyString,
    objective: NonEmptyString,
    idempotencyKey: NonEmptyString,
    actorId: NonEmptyString,
  },
  { additionalProperties: false },
);
export const WorkProjectsListParamsSchema = Type.Object({}, { additionalProperties: false });
export const WorkProjectsGetParamsSchema = Type.Object(
  { projectId: NonEmptyString },
  { additionalProperties: false },
);
export const WorkPlansCreateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    planId: NonEmptyString,
    goalId: NonEmptyString,
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: NonEmptyString,
    actorId: NonEmptyString,
    status: Type.Optional(WorkPlanStatusSchema),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    requirements: Type.Optional(Type.Array(RequirementSchema)),
  },
  { additionalProperties: false },
);
export const WorkPlansGetParamsSchema = Type.Object(
  { planId: NonEmptyString },
  { additionalProperties: false },
);
export const WorkPlansMutateParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    planId: NonEmptyString,
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: NonEmptyString,
    actorId: NonEmptyString,
    mutation: MutationSchema,
  },
  { additionalProperties: false },
);
export const WorkPlansHistoryParamsSchema = Type.Object(
  { planId: NonEmptyString },
  { additionalProperties: false },
);
export const WorkPlansProjectionParamsSchema = WorkPlansGetParamsSchema;

export type WorkProjectsCreateParams = Static<typeof WorkProjectsCreateParamsSchema>;
export type WorkProjectsListParams = Static<typeof WorkProjectsListParamsSchema>;
export type WorkProjectsGetParams = Static<typeof WorkProjectsGetParamsSchema>;
export type WorkPlansCreateParams = Static<typeof WorkPlansCreateParamsSchema>;
export type WorkPlansGetParams = Static<typeof WorkPlansGetParamsSchema>;
export type WorkPlansMutateParams = Static<typeof WorkPlansMutateParamsSchema>;
export type WorkPlansHistoryParams = Static<typeof WorkPlansHistoryParamsSchema>;
export type WorkPlansProjectionParams = Static<typeof WorkPlansProjectionParamsSchema>;
