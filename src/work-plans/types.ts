export const WORK_PLAN_STATUSES = [
  "draft",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type WorkPlanStatus = (typeof WORK_PLAN_STATUSES)[number];

export const WORK_STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "superseded",
] as const;
export type WorkStepStatus = (typeof WORK_STEP_STATUSES)[number];
export type RequirementDisposition = "mapped" | "excluded" | "unresolved";
export type WorkOwnerType = "task" | "task_flow" | "codex" | "omx" | "external";

export type WorkStepDefinition = {
  stepId: string;
  title: string;
  status?: WorkStepStatus;
  dependsOn?: string[];
};
export type WorkRequirementDefinition = {
  requirementId: string;
  text: string;
  disposition: RequirementDisposition;
  mappedStepId?: string;
  exclusionReason?: string;
};
export type WorkAttempt = {
  attemptId: string;
  stepId: string;
  attemptNumber: number;
  ownerType: WorkOwnerType;
  ownerId: string;
  ownerState: string;
  recoveryState?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
export type WorkStep = Required<Pick<WorkStepDefinition, "stepId" | "title">> & {
  ordinal: number;
  status: WorkStepStatus;
  recordRevision: number;
  dependsOn: string[];
  taskLinks: Array<{ taskId: string; taskFlowId?: string }>;
  worktreeLinks: string[];
  attempts: WorkAttempt[];
};
export type WorkRequirement = WorkRequirementDefinition;
export type WorkPlanProjection = {
  display: string;
  x: number;
  n: number;
  activeStepIds: string[];
  readyStepIds: string[];
  statusCounts: Partial<Record<WorkStepStatus, number>>;
};
export type WorkPlanSnapshot = {
  schemaVersion: 1;
  projectId: string;
  primaryConversationId: string;
  projectRecordRevision: number;
  goal: { goalId: string; objective: string; sessionGoalRef?: string; recordRevision: number };
  planId: string;
  status: WorkPlanStatus;
  definitionRevision: number;
  recordRevision: number;
  createdAt: number;
  updatedAt: number;
  steps: WorkStep[];
  requirements: WorkRequirement[];
  projection: WorkPlanProjection;
};
export type WorkPlanTransition = {
  sequence: number;
  transitionId: string;
  projectId: string;
  planId?: string;
  stepId?: string;
  definitionRevision?: number;
  entityType: string;
  fromStatus?: string;
  toStatus?: string;
  action: string;
  actorId: string;
  requestHash: string;
  payloadJson: string;
  createdAt: number;
};
export type WorkPlanLineage = {
  definitions: Array<{
    definitionRevision: number;
    stepId: string;
    status: WorkStepStatus;
    supersededAt?: number;
  }>;
  taskLinks: Array<{
    definitionRevision: number;
    stepId: string;
    taskId: string;
    taskFlowId?: string;
    linkedAt: number;
  }>;
  worktreeLinks: Array<{
    definitionRevision: number;
    stepId: string;
    worktreeId: string;
    linkedAt: number;
  }>;
  attempts: WorkAttempt[];
};
export type WorkPlanMutation =
  | { action: "setPlanStatus"; status: WorkPlanStatus }
  | { action: "setStepStatus"; stepId: string; status: WorkStepStatus }
  | { action: "skipStep"; stepId: string }
  | { action: "linkTask"; stepId: string; taskId: string; taskFlowId?: string }
  | { action: "linkWorktree"; stepId: string; worktreeId: string }
  | {
      action: "startAttempt";
      stepId: string;
      attemptId: string;
      ownerType: WorkOwnerType;
      ownerId: string;
    }
  | {
      action: "retryStep";
      stepId: string;
      attemptId: string;
      ownerType: WorkOwnerType;
      ownerId: string;
    }
  | {
      action: "reconcileAttempt";
      attemptId: string;
      ownerState: string;
      recoveryState?: string;
      stepStatus?: WorkStepStatus;
    }
  | { action: "reconcileLocalOwners" }
  | { action: "splitStep"; stepId: string; replacementSteps: WorkStepDefinition[] }
  | { action: "mergeSteps"; stepIds: string[]; replacementStep: WorkStepDefinition }
  | { action: "replan"; steps: WorkStepDefinition[]; requirements: WorkRequirementDefinition[] };

export type WorkMutationEnvelope = {
  projectId: string;
  planId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorId: string;
  mutation: WorkPlanMutation;
};

export class WorkPlanConflictError extends Error {}
export class WorkPlanValidationError extends Error {}
export class WorkPlanNotFoundError extends Error {}
