import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 256 });
const TextSchema = Type.String({ minLength: 1, maxLength: 16_384 });

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
  Type.Literal("external"),
]);
const StepSchema = Type.Object(
  {
    stepId: IdentifierSchema,
    title: TextSchema,
    status: Type.Optional(WorkStepStatusSchema),
    dependsOn: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true, maxItems: 1_000 })),
  },
  { additionalProperties: false },
);
const RequirementSchema = Type.Object(
  {
    requirementId: IdentifierSchema,
    text: TextSchema,
    disposition: Type.Union([
      Type.Literal("mapped"),
      Type.Literal("excluded"),
      Type.Literal("unresolved"),
    ]),
    mappedStepId: Type.Optional(IdentifierSchema),
    exclusionReason: Type.Optional(TextSchema),
  },
  { additionalProperties: false },
);
const MutationSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("setPlanStatus"), status: WorkPlanStatusSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("setStepStatus"),
      stepId: IdentifierSchema,
      status: WorkStepStatusSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("skipStep"), stepId: IdentifierSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("startAttempt"),
      stepId: IdentifierSchema,
      attemptId: IdentifierSchema,
      ownerType: OwnerTypeSchema,
      ownerId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("linkTask"),
      stepId: IdentifierSchema,
      taskId: IdentifierSchema,
      taskFlowId: Type.Optional(IdentifierSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("linkWorktree"),
      stepId: IdentifierSchema,
      worktreeId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("retryStep"),
      stepId: IdentifierSchema,
      attemptId: IdentifierSchema,
      ownerType: OwnerTypeSchema,
      ownerId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("reconcileAttempt"),
      attemptId: IdentifierSchema,
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
      recoveryState: Type.Optional(TextSchema),
      stepStatus: Type.Optional(WorkStepStatusSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("reconcileLocalOwners") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("splitStep"),
      stepId: IdentifierSchema,
      replacementSteps: Type.Array(StepSchema, { minItems: 2, maxItems: 1_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("mergeSteps"),
      stepIds: Type.Array(IdentifierSchema, { minItems: 2, maxItems: 1_000, uniqueItems: true }),
      replacementStep: StepSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("replan"),
      steps: Type.Array(StepSchema, { minItems: 1, maxItems: 1_000 }),
      requirements: Type.Array(RequirementSchema, { maxItems: 1_000 }),
    },
    { additionalProperties: false },
  ),
]);

export const WorkProjectsCreateParamsSchema = Type.Object(
  {
    projectId: IdentifierSchema,
    goalId: IdentifierSchema,
    primaryConversationId: IdentifierSchema,
    sessionGoalRef: Type.Optional(IdentifierSchema),
    objective: TextSchema,
    idempotencyKey: IdentifierSchema,
  },
  { additionalProperties: false },
);
export const WorkProjectsListParamsSchema = Type.Object({}, { additionalProperties: false });
export const WorkProjectsGetParamsSchema = Type.Object(
  { projectId: IdentifierSchema },
  { additionalProperties: false },
);
export const WorkPlansCreateParamsSchema = Type.Object(
  {
    projectId: IdentifierSchema,
    planId: IdentifierSchema,
    goalId: IdentifierSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: IdentifierSchema,
    status: Type.Optional(WorkPlanStatusSchema),
    steps: Type.Array(StepSchema, { minItems: 1, maxItems: 1_000 }),
    requirements: Type.Optional(Type.Array(RequirementSchema, { maxItems: 1_000 })),
  },
  { additionalProperties: false },
);
export const WorkPlansGetParamsSchema = Type.Object(
  { planId: IdentifierSchema },
  { additionalProperties: false },
);
export const WorkPlansMutateParamsSchema = Type.Object(
  {
    projectId: IdentifierSchema,
    planId: IdentifierSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: IdentifierSchema,
    mutation: MutationSchema,
  },
  { additionalProperties: false },
);
export const WorkPlansHistoryParamsSchema = Type.Object(
  { planId: IdentifierSchema },
  { additionalProperties: false },
);
export const WorkPlansProjectionParamsSchema = WorkPlansGetParamsSchema;

const StatusCountsSchema = Type.Record(Type.String(), Type.Integer({ minimum: 0 }));
const ProjectionSchema = Type.Object({
  display: NonEmptyString,
  x: Type.Integer({ minimum: 0 }),
  n: Type.Integer({ minimum: 1 }),
  activeStepIds: Type.Array(NonEmptyString),
  readyStepIds: Type.Array(NonEmptyString),
  statusCounts: StatusCountsSchema,
});
const AttemptResultSchema = Type.Object(
  {
    attemptId: NonEmptyString,
    stepId: NonEmptyString,
    attemptNumber: Type.Integer({ minimum: 1 }),
    ownerType: OwnerTypeSchema,
    ownerId: NonEmptyString,
    ownerState: NonEmptyString,
    recoveryState: Type.Optional(NonEmptyString),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    endedAt: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const StepResultSchema = Type.Object(
  {
    stepId: NonEmptyString,
    title: NonEmptyString,
    ordinal: Type.Integer({ minimum: 0 }),
    status: WorkStepStatusSchema,
    recordRevision: Type.Integer({ minimum: 1 }),
    dependsOn: Type.Array(NonEmptyString),
    taskLinks: Type.Array(
      Type.Object(
        { taskId: NonEmptyString, taskFlowId: Type.Optional(NonEmptyString) },
        { additionalProperties: false },
      ),
    ),
    worktreeLinks: Type.Array(NonEmptyString),
    attempts: Type.Array(AttemptResultSchema),
  },
  { additionalProperties: false },
);
const RequirementResultSchema = Type.Object(
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
export const WorkPlanSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    projectId: NonEmptyString,
    primaryConversationId: NonEmptyString,
    projectRecordRevision: Type.Integer({ minimum: 1 }),
    goal: Type.Object(
      {
        goalId: NonEmptyString,
        objective: NonEmptyString,
        sessionGoalRef: Type.Optional(NonEmptyString),
        recordRevision: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    planId: NonEmptyString,
    status: WorkPlanStatusSchema,
    definitionRevision: Type.Integer({ minimum: 1 }),
    recordRevision: Type.Integer({ minimum: 1 }),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    steps: Type.Array(StepResultSchema),
    requirements: Type.Array(RequirementResultSchema),
    projection: ProjectionSchema,
  },
  { additionalProperties: false },
);
const ProjectSummarySchema = Type.Object(
  {
    projectId: NonEmptyString,
    primaryConversationId: NonEmptyString,
    recordRevision: Type.Integer({ minimum: 1 }),
    updatedAt: Type.Integer(),
  },
  { additionalProperties: false },
);
export const WorkProjectsCreateResultSchema = Type.Object(
  {
    projectId: NonEmptyString,
    goalId: NonEmptyString,
    recordRevision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const WorkProjectsListResultSchema = Type.Object(
  { projects: Type.Array(ProjectSummarySchema) },
  { additionalProperties: false },
);
export const WorkProjectsGetResultSchema = Type.Object(
  {
    project: Type.Intersect([
      ProjectSummarySchema,
      Type.Object({ plans: Type.Array(WorkPlanSnapshotSchema) }),
    ]),
  },
  { additionalProperties: false },
);
export const WorkPlansCreateResultSchema = Type.Object(
  { plan: WorkPlanSnapshotSchema },
  { additionalProperties: false },
);
export const WorkPlansGetResultSchema = WorkPlansCreateResultSchema;
export const WorkPlansMutateResultSchema = WorkPlansCreateResultSchema;
const TransitionResultSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    transitionId: NonEmptyString,
    projectId: NonEmptyString,
    planId: Type.Optional(NonEmptyString),
    stepId: Type.Optional(NonEmptyString),
    definitionRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    entityType: NonEmptyString,
    fromStatus: Type.Optional(NonEmptyString),
    toStatus: Type.Optional(NonEmptyString),
    action: NonEmptyString,
    actorId: NonEmptyString,
    requestHash: NonEmptyString,
    payloadJson: Type.String({ maxLength: 65_536 }),
    createdAt: Type.Integer(),
  },
  { additionalProperties: false },
);
const LineageSchema = Type.Object(
  {
    definitions: Type.Array(
      Type.Object(
        {
          definitionRevision: Type.Integer({ minimum: 1 }),
          stepId: NonEmptyString,
          status: WorkStepStatusSchema,
          supersededAt: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    taskLinks: Type.Array(
      Type.Object(
        {
          definitionRevision: Type.Integer({ minimum: 1 }),
          stepId: NonEmptyString,
          taskId: NonEmptyString,
          taskFlowId: Type.Optional(NonEmptyString),
          linkedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    worktreeLinks: Type.Array(
      Type.Object(
        {
          definitionRevision: Type.Integer({ minimum: 1 }),
          stepId: NonEmptyString,
          worktreeId: NonEmptyString,
          linkedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    attempts: Type.Array(AttemptResultSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);
export const WorkPlansHistoryResultSchema = Type.Object(
  {
    transitions: Type.Array(TransitionResultSchema, { maxItems: 10_000 }),
    lineage: LineageSchema,
  },
  { additionalProperties: false },
);
export const WorkPlansProjectionResultSchema = Type.Object(
  { projection: ProjectionSchema },
  { additionalProperties: false },
);

export type WorkProjectsCreateParams = Static<typeof WorkProjectsCreateParamsSchema>;
export type WorkProjectsListParams = Static<typeof WorkProjectsListParamsSchema>;
export type WorkProjectsGetParams = Static<typeof WorkProjectsGetParamsSchema>;
export type WorkPlansCreateParams = Static<typeof WorkPlansCreateParamsSchema>;
export type WorkPlansGetParams = Static<typeof WorkPlansGetParamsSchema>;
export type WorkPlansMutateParams = Static<typeof WorkPlansMutateParamsSchema>;
export type WorkPlansHistoryParams = Static<typeof WorkPlansHistoryParamsSchema>;
export type WorkPlansProjectionParams = Static<typeof WorkPlansProjectionParamsSchema>;
export type WorkProjectsCreateResult = Static<typeof WorkProjectsCreateResultSchema>;
export type WorkProjectsListResult = Static<typeof WorkProjectsListResultSchema>;
export type WorkProjectsGetResult = Static<typeof WorkProjectsGetResultSchema>;
export type WorkPlansCreateResult = Static<typeof WorkPlansCreateResultSchema>;
export type WorkPlansGetResult = Static<typeof WorkPlansGetResultSchema>;
export type WorkPlansMutateResult = Static<typeof WorkPlansMutateResultSchema>;
export type WorkPlansHistoryResult = Static<typeof WorkPlansHistoryResultSchema>;
export type WorkPlansProjectionResult = Static<typeof WorkPlansProjectionResultSchema>;
