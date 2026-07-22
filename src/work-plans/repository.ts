/* oxlint-disable oxc/no-map-spread -- immutable projection records are intentional here */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  type WorkMutationEnvelope,
  type WorkPlanMutation,
  type WorkPlanProjection,
  type WorkPlanLineage,
  type WorkPlanSnapshot,
  type WorkPlanStatus,
  type WorkPlanTransition,
  type WorkRequirementDefinition,
  type WorkStepDefinition,
  type WorkStepStatus,
  WorkPlanConflictError,
  WorkPlanNotFoundError,
  WorkPlanValidationError,
} from "./types.js";

type RepositoryOptions = OpenClawStateDatabaseOptions & { now?: () => number };
type Row = Record<string, string | number | null>;
const TERMINAL_PROGRESS = new Set<WorkStepStatus>(["succeeded", "skipped"]);
const ACTIVE = new Set<WorkStepStatus>(["ready", "running", "waiting", "blocked", "review"]);
const TERMINAL_PLAN = new Set<WorkPlanStatus>(["completed", "failed", "cancelled", "superseded"]);
const OWNER_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(["running", "waiting", "succeeded", "failed", "cancelled", "lost", "unknown"]),
  running: new Set(["waiting", "succeeded", "failed", "cancelled", "lost", "unknown"]),
  waiting: new Set(["running", "succeeded", "failed", "cancelled", "lost", "unknown"]),
  unknown: new Set(["pending", "running", "waiting", "succeeded", "failed", "cancelled", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};
const PLAN_TRANSITIONS: Record<WorkPlanStatus, ReadonlySet<WorkPlanStatus>> = {
  draft: new Set(["ready", "cancelled", "superseded"]),
  ready: new Set(["running", "waiting", "blocked", "cancelled", "superseded"]),
  running: new Set([
    "waiting",
    "blocked",
    "review",
    "completed",
    "failed",
    "cancelled",
    "superseded",
  ]),
  waiting: new Set(["ready", "running", "blocked", "cancelled", "superseded"]),
  blocked: new Set(["ready", "running", "failed", "cancelled", "superseded"]),
  review: new Set(["running", "completed", "failed", "cancelled", "superseded"]),
  completed: new Set(),
  failed: new Set(["ready", "cancelled", "superseded"]),
  cancelled: new Set(),
  superseded: new Set(),
};
const STEP_TRANSITIONS: Record<WorkStepStatus, ReadonlySet<WorkStepStatus>> = {
  pending: new Set(["ready", "skipped", "cancelled", "superseded"]),
  ready: new Set([
    "running",
    "waiting",
    "blocked",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
    "superseded",
  ]),
  running: new Set([
    "waiting",
    "blocked",
    "review",
    "succeeded",
    "failed",
    "cancelled",
    "superseded",
  ]),
  waiting: new Set(["ready", "running", "blocked", "failed", "cancelled", "superseded"]),
  blocked: new Set(["ready", "running", "failed", "skipped", "cancelled", "superseded"]),
  review: new Set(["running", "succeeded", "failed", "cancelled", "superseded"]),
  succeeded: new Set(),
  failed: new Set(["ready", "cancelled", "superseded"]),
  skipped: new Set(),
  cancelled: new Set(["ready", "superseded"]),
  superseded: new Set(),
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function requestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function requireText(value: string, name: string): void {
  if (!value.trim()) {
    throw new WorkPlanValidationError(`${name} must be non-empty`);
  }
}

function validateDefinition(
  steps: WorkStepDefinition[],
  requirements: WorkRequirementDefinition[],
): void {
  if (steps.length === 0) {
    throw new WorkPlanValidationError("a plan requires at least one step");
  }
  const ids = new Set<string>();
  for (const step of steps) {
    requireText(step.stepId, "stepId");
    requireText(step.title, "step title");
    if (ids.has(step.stepId)) {
      throw new WorkPlanValidationError(`duplicate step: ${step.stepId}`);
    }
    ids.add(step.stepId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new WorkPlanValidationError("step dependency cycle");
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new WorkPlanValidationError(`unknown dependency: ${dependency}`);
      }
      if (dependency === id) {
        throw new WorkPlanValidationError("step cannot depend on itself");
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) {
    visit(id);
  }
  const requirementIds = new Set<string>();
  for (const requirement of requirements) {
    if (requirementIds.has(requirement.requirementId)) {
      throw new WorkPlanValidationError(`duplicate requirement: ${requirement.requirementId}`);
    }
    requirementIds.add(requirement.requirementId);
    if (
      requirement.disposition === "mapped" &&
      (!requirement.mappedStepId || !ids.has(requirement.mappedStepId))
    ) {
      throw new WorkPlanValidationError(
        `mapped requirement ${requirement.requirementId} needs an active step`,
      );
    }
    if (requirement.disposition === "excluded" && !requirement.exclusionReason?.trim()) {
      throw new WorkPlanValidationError(
        `excluded requirement ${requirement.requirementId} needs a reason`,
      );
    }
    if (
      requirement.disposition === "unresolved" &&
      (requirement.mappedStepId || requirement.exclusionReason)
    ) {
      throw new WorkPlanValidationError(
        `unresolved requirement ${requirement.requirementId} cannot be resolved implicitly`,
      );
    }
  }
}

function normalizeReady(steps: WorkStepDefinition[]): WorkStepDefinition[] {
  const statuses = new Map(steps.map((s) => [s.stepId, s.status ?? "pending"]));
  return steps.map((step) => {
    const status = step.status ?? "pending";
    if (status !== "pending" && status !== "ready") {
      return step;
    }
    const ready = (step.dependsOn ?? []).every((id) =>
      TERMINAL_PROGRESS.has(statuses.get(id) ?? "pending"),
    );
    return { ...step, status: ready ? "ready" : "pending" };
  });
}

export class WorkPlanRepository {
  readonly #options: RepositoryOptions;
  constructor(options: RepositoryOptions = {}) {
    this.#options = options;
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  #db(): DatabaseSync {
    return openOpenClawStateDatabase(this.#options).db;
  }

  createProject(input: {
    projectId: string;
    goalId: string;
    primaryConversationId: string;
    sessionGoalRef?: string;
    objective: string;
    idempotencyKey: string;
    actorId: string;
  }): { projectId: string; goalId: string; recordRevision: number } {
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as { projectId: string; goalId: string; recordRevision: number };
      }
      requireText(input.projectId, "projectId");
      requireText(input.primaryConversationId, "primaryConversationId");
      requireText(input.objective, "objective");
      db.prepare(
        "INSERT INTO work_projects(project_id,primary_conversation_id,created_at,updated_at) VALUES(?,?,?,?)",
      ).run(input.projectId, input.primaryConversationId, now, now);
      db.prepare(
        "INSERT INTO work_goals(goal_id,project_id,origin_session_key,session_goal_id,objective,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        input.goalId,
        input.projectId,
        input.primaryConversationId,
        input.sessionGoalRef ?? null,
        input.objective,
        now,
        now,
      );
      const result = { projectId: input.projectId, goalId: input.goalId, recordRevision: 1 };
      this.#transition(db, {
        projectId: input.projectId,
        entityType: "project",
        action: "create",
        actorId: input.actorId,
        hash,
        payload: result,
        now,
      });
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  listProjects(): Array<{
    projectId: string;
    primaryConversationId: string;
    recordRevision: number;
    updatedAt: number;
  }> {
    return (
      this.#db()
        .prepare(
          "SELECT project_id,primary_conversation_id,record_revision,updated_at FROM work_projects ORDER BY updated_at DESC,project_id",
        )
        .all() as Row[]
    ).map((r) => ({
      projectId: String(r.project_id),
      primaryConversationId: String(r.primary_conversation_id),
      recordRevision: Number(r.record_revision),
      updatedAt: Number(r.updated_at),
    }));
  }

  getProject(projectId: string): {
    projectId: string;
    primaryConversationId: string;
    recordRevision: number;
    updatedAt: number;
    plans: WorkPlanSnapshot[];
  } {
    const project = this.listProjects().find((candidate) => candidate.projectId === projectId);
    if (!project) {
      throw new WorkPlanNotFoundError(`project not found: ${projectId}`);
    }
    const planIds = (
      this.#db()
        .prepare("SELECT plan_id FROM work_plans WHERE project_id=? ORDER BY updated_at DESC")
        .all(projectId) as Row[]
    ).map((row) => String(row.plan_id));
    return { ...project, plans: planIds.map((planId) => this.getPlan(planId)) };
  }

  createPlan(input: {
    projectId: string;
    planId: string;
    goalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    status?: WorkPlanStatus;
    steps: WorkStepDefinition[];
    requirements?: WorkRequirementDefinition[];
  }): WorkPlanSnapshot {
    const hash = requestHash(input);
    const now = this.#now();
    const requirements = input.requirements ?? [];
    validateDefinition(input.steps, requirements);
    const initialStatus = input.status ?? "draft";
    const initialStepStatuses = input.steps.map((step) => step.status ?? "pending");
    if (initialStatus === "superseded") {
      throw new WorkPlanValidationError("a plan cannot be created superseded");
    }
    if (
      initialStatus === "completed" &&
      initialStepStatuses.some((status) => !TERMINAL_PROGRESS.has(status))
    ) {
      throw new WorkPlanValidationError("a completed plan requires every step to succeed or skip");
    }
    if (initialStatus === "failed" && !initialStepStatuses.includes("failed")) {
      throw new WorkPlanValidationError("a failed plan requires a failed step");
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as WorkPlanSnapshot;
      }
      const project = db
        .prepare("SELECT record_revision FROM work_projects WHERE project_id=?")
        .get(input.projectId) as Row | undefined;
      if (!project) {
        throw new WorkPlanNotFoundError(`project not found: ${input.projectId}`);
      }
      if (Number(project.record_revision) !== input.expectedRevision) {
        throw new WorkPlanConflictError("stale project revision");
      }
      const goal = db
        .prepare("SELECT 1 AS ok FROM work_goals WHERE goal_id=? AND project_id=?")
        .get(input.goalId, input.projectId) as Row | undefined;
      if (!goal) {
        throw new WorkPlanValidationError("goal does not belong to project");
      }
      db.prepare(
        "INSERT INTO work_plans(plan_id,project_id,goal_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(input.planId, input.projectId, input.goalId, initialStatus, now, now);
      this.#insertDefinition(db, input.planId, 1, normalizeReady(input.steps), requirements, now);
      const updated = db
        .prepare(
          "UPDATE work_projects SET record_revision=record_revision+1,updated_at=? WHERE project_id=? AND record_revision=?",
        )
        .run(now, input.projectId, input.expectedRevision);
      if (updated.changes !== 1) {
        throw new WorkPlanConflictError("stale project revision");
      }
      this.#transition(db, {
        projectId: input.projectId,
        planId: input.planId,
        definitionRevision: 1,
        entityType: "plan",
        toStatus: initialStatus,
        action: "create",
        actorId: input.actorId,
        hash,
        payload: input,
        now,
      });
      this.#refreshCursor(db, input.planId);
      const result = this.#load(db, input.planId);
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  getPlan(planId: string): WorkPlanSnapshot {
    return this.#load(this.#db(), planId);
  }

  mutate(input: WorkMutationEnvelope): WorkPlanSnapshot {
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as WorkPlanSnapshot;
      }
      const plan = db
        .prepare("SELECT * FROM work_plans WHERE plan_id=? AND project_id=?")
        .get(input.planId, input.projectId) as Row | undefined;
      if (!plan) {
        throw new WorkPlanNotFoundError(`plan not found: ${input.planId}`);
      }
      if (Number(plan.record_revision) !== input.expectedRevision) {
        throw new WorkPlanConflictError("stale plan revision");
      }
      const before = this.#load(db, input.planId);
      if (TERMINAL_PLAN.has(before.status) && input.mutation.action !== "setPlanStatus") {
        throw new WorkPlanValidationError(`cannot ${input.mutation.action} a terminal plan`);
      }
      this.#applyMutation(db, before, input.mutation, now);
      const next = db
        .prepare(
          "UPDATE work_plans SET record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND record_revision=?",
        )
        .run(now, input.planId, input.expectedRevision);
      if (next.changes !== 1) {
        throw new WorkPlanConflictError("stale plan revision");
      }
      this.#refreshCursor(db, input.planId);
      const result = this.#load(db, input.planId);
      const affectedStepId = "stepId" in input.mutation ? input.mutation.stepId : undefined;
      const beforeStepStatus = affectedStepId
        ? before.steps.find((step) => step.stepId === affectedStepId)?.status
        : undefined;
      const afterStepStatus = affectedStepId
        ? result.steps.find((step) => step.stepId === affectedStepId)?.status
        : undefined;
      this.#transition(db, {
        projectId: input.projectId,
        planId: input.planId,
        definitionRevision: result.definitionRevision,
        stepId: affectedStepId,
        entityType:
          input.mutation.action.includes("Plan") || input.mutation.action === "replan"
            ? "plan"
            : "step",
        fromStatus: input.mutation.action === "setPlanStatus" ? before.status : beforeStepStatus,
        toStatus: input.mutation.action === "setPlanStatus" ? result.status : afterStepStatus,
        action: input.mutation.action,
        actorId: input.actorId,
        hash,
        payload: input.mutation,
        now,
      });
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  history(planId: string): WorkPlanTransition[] {
    const rows = this.#db()
      .prepare("SELECT * FROM work_plan_transitions WHERE plan_id=? ORDER BY sequence")
      .all(planId) as Row[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      transitionId: String(row.transition_id),
      projectId: String(row.project_id),
      ...(row.plan_id ? { planId: String(row.plan_id) } : {}),
      ...(row.step_id ? { stepId: String(row.step_id) } : {}),
      ...(row.definition_revision !== null
        ? { definitionRevision: Number(row.definition_revision) }
        : {}),
      entityType: String(row.entity_type),
      ...(row.from_status ? { fromStatus: String(row.from_status) } : {}),
      ...(row.to_status ? { toStatus: String(row.to_status) } : {}),
      action: String(row.action),
      actorId: String(row.actor_id),
      requestHash: String(row.request_hash),
      payloadJson: String(row.payload_json),
      createdAt: Number(row.created_at),
    }));
  }

  lineage(planId: string): WorkPlanLineage {
    const db = this.#db();
    const definitions = db
      .prepare(
        "SELECT definition_revision,step_id,status,superseded_at FROM work_plan_steps WHERE plan_id=? ORDER BY definition_revision,ordinal",
      )
      .all(planId) as Row[];
    const taskLinks = db
      .prepare(
        "SELECT * FROM work_plan_step_task_links WHERE plan_id=? ORDER BY definition_revision,step_id,task_id",
      )
      .all(planId) as Row[];
    const attempts = db
      .prepare(
        "SELECT * FROM work_plan_step_attempts WHERE plan_id=? ORDER BY definition_revision,step_id,attempt_number",
      )
      .all(planId) as Row[];
    const worktreeLinks = db
      .prepare(
        "SELECT * FROM work_plan_step_worktree_links WHERE plan_id=? ORDER BY definition_revision,step_id,worktree_id",
      )
      .all(planId) as Row[];
    return {
      definitions: definitions.map((row) => ({
        definitionRevision: Number(row.definition_revision),
        stepId: String(row.step_id),
        status: String(row.status) as WorkStepStatus,
        ...(row.superseded_at ? { supersededAt: Number(row.superseded_at) } : {}),
      })),
      taskLinks: taskLinks.map((row) => ({
        definitionRevision: Number(row.definition_revision),
        stepId: String(row.step_id),
        taskId: String(row.task_id),
        ...(row.task_flow_id ? { taskFlowId: String(row.task_flow_id) } : {}),
        linkedAt: Number(row.linked_at),
      })),
      worktreeLinks: worktreeLinks.map((row) => ({
        definitionRevision: Number(row.definition_revision),
        stepId: String(row.step_id),
        worktreeId: String(row.worktree_id),
        linkedAt: Number(row.linked_at),
      })),
      attempts: attempts.map((row) => ({
        attemptId: String(row.attempt_id),
        stepId: String(row.step_id),
        attemptNumber: Number(row.attempt_number),
        ownerType: String(row.owner_type) as never,
        ownerId: String(row.owner_id),
        ownerState: String(row.owner_state),
        ...(row.recovery_state ? { recoveryState: String(row.recovery_state) } : {}),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}),
      })),
    };
  }

  #receipt(db: DatabaseSync, projectId: string, key: string, hash: string): unknown | undefined {
    const row = db
      .prepare(
        "SELECT request_hash,result_json FROM work_plan_mutation_receipts WHERE project_id=? AND idempotency_key=?",
      )
      .get(projectId, key) as Row | undefined;
    if (!row) {
      return undefined;
    }
    if (row.request_hash !== hash) {
      throw new WorkPlanConflictError("idempotency key reused with a different request");
    }
    return JSON.parse(String(row.result_json));
  }
  #saveReceipt(
    db: DatabaseSync,
    projectId: string,
    key: string,
    hash: string,
    result: unknown,
    now: number,
  ): void {
    db.prepare(
      "INSERT INTO work_plan_mutation_receipts(project_id,idempotency_key,request_hash,result_json,created_at) VALUES(?,?,?,?,?)",
    ).run(projectId, key, hash, JSON.stringify(result), now);
  }
  #transition(
    db: DatabaseSync,
    input: {
      projectId: string;
      planId?: string;
      stepId?: string;
      definitionRevision?: number;
      entityType: string;
      fromStatus?: string;
      toStatus?: string;
      action: string;
      actorId: string;
      hash: string;
      payload: unknown;
      now: number;
    },
  ): void {
    db.prepare(
      "INSERT INTO work_plan_transitions(transition_id,project_id,plan_id,step_id,definition_revision,entity_type,from_status,to_status,action,actor_id,request_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      input.projectId,
      input.planId ?? null,
      input.stepId ?? null,
      input.definitionRevision ?? null,
      input.entityType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.action,
      input.actorId,
      input.hash,
      JSON.stringify(input.payload),
      input.now,
    );
  }
  #insertDefinition(
    db: DatabaseSync,
    planId: string,
    revision: number,
    steps: WorkStepDefinition[],
    requirements: WorkRequirementDefinition[],
    now: number,
  ): void {
    validateDefinition(steps, requirements);
    const insertStep = db.prepare(
      "INSERT INTO work_plan_steps(plan_id,definition_revision,step_id,ordinal,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    const insertDependency = db.prepare(
      "INSERT INTO work_plan_step_dependencies(plan_id,definition_revision,step_id,depends_on_step_id) VALUES(?,?,?,?)",
    );
    for (const [ordinal, step] of normalizeReady(steps).entries()) {
      insertStep.run(
        planId,
        revision,
        step.stepId,
        ordinal,
        step.title,
        step.status ?? "pending",
        now,
        now,
      );
      for (const dependency of step.dependsOn ?? []) {
        insertDependency.run(planId, revision, step.stepId, dependency);
      }
    }
    const insertRequirement = db.prepare(
      "INSERT INTO work_plan_requirements(plan_id,definition_revision,requirement_id,requirement_text,disposition,mapped_step_id,exclusion_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    for (const requirement of requirements) {
      insertRequirement.run(
        planId,
        revision,
        requirement.requirementId,
        requirement.text,
        requirement.disposition,
        requirement.mappedStepId ?? null,
        requirement.exclusionReason ?? null,
        now,
        now,
      );
    }
  }
  #applyMutation(
    db: DatabaseSync,
    before: WorkPlanSnapshot,
    mutation: WorkPlanMutation,
    now: number,
  ): void {
    const step = (id: string) => {
      const found = before.steps.find((candidate) => candidate.stepId === id);
      if (!found) {
        throw new WorkPlanValidationError(`unknown step: ${id}`);
      }
      return found;
    };
    if (mutation.action === "setPlanStatus") {
      if (!PLAN_TRANSITIONS[before.status].has(mutation.status)) {
        throw new WorkPlanValidationError(
          `invalid plan transition: ${before.status} -> ${mutation.status}`,
        );
      }
      if (
        mutation.status === "completed" &&
        before.steps.some((candidate) => !TERMINAL_PROGRESS.has(candidate.status))
      ) {
        throw new WorkPlanValidationError(
          "a plan cannot complete before every active-definition step succeeds or skips",
        );
      }
      db.prepare("UPDATE work_plans SET status=? WHERE plan_id=?").run(
        mutation.status,
        before.planId,
      );
      return;
    }
    if (mutation.action === "setStepStatus" || mutation.action === "skipStep") {
      const id = mutation.stepId;
      const current = step(id);
      const status = mutation.action === "skipStep" ? "skipped" : mutation.status;
      if (new Set<WorkStepStatus>(["succeeded", "failed", "skipped", "cancelled"]).has(status)) {
        const activeAttempt = db
          .prepare(
            "SELECT 1 AS ok FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? AND step_id=? AND owner_state IN ('pending','running','waiting') LIMIT 1",
          )
          .get(before.planId, before.definitionRevision, id);
        if (activeAttempt) {
          throw new WorkPlanValidationError(
            "an active owner attempt must be reconciled before terminalizing its step",
          );
        }
      }
      if (!STEP_TRANSITIONS[current.status].has(status)) {
        throw new WorkPlanValidationError(
          `invalid step transition: ${current.status} -> ${status}`,
        );
      }
      db.prepare(
        "UPDATE work_plan_steps SET status=?,record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
      ).run(status, now, before.planId, before.definitionRevision, id);
      this.#normalizeStoredReady(db, before.planId, before.definitionRevision, now);
      return;
    }
    if (mutation.action === "linkTask") {
      step(mutation.stepId);
      const taskOwner = db
        .prepare("SELECT parent_flow_id FROM task_runs WHERE task_id=?")
        .get(mutation.taskId) as Row | undefined;
      if (!taskOwner) {
        throw new WorkPlanValidationError(`task owner not found: ${mutation.taskId}`);
      }
      if (mutation.taskFlowId) {
        this.#assertLocalOwner(db, "task_flow", mutation.taskFlowId);
      }
      if ((taskOwner.parent_flow_id ?? null) !== (mutation.taskFlowId ?? null)) {
        throw new WorkPlanValidationError(
          "task flow link does not match the task authority record",
        );
      }
      const prior = db
        .prepare(
          "SELECT task_flow_id FROM work_plan_step_task_links WHERE plan_id=? AND definition_revision=? AND step_id=? AND task_id=?",
        )
        .get(before.planId, before.definitionRevision, mutation.stepId, mutation.taskId) as
        | Row
        | undefined;
      if (prior) {
        if ((prior.task_flow_id ?? null) !== (mutation.taskFlowId ?? null)) {
          throw new WorkPlanConflictError("task link already exists with a different flow");
        }
        throw new WorkPlanConflictError(
          "task link already exists; replay requires the original idempotency key",
        );
      }
      const existingTaskOwner = db
        .prepare("SELECT plan_id,step_id FROM work_plan_step_task_links WHERE task_id=?")
        .get(mutation.taskId) as Row | undefined;
      if (existingTaskOwner) {
        throw new WorkPlanConflictError(
          `task already linked to ${existingTaskOwner.plan_id}/${existingTaskOwner.step_id}`,
        );
      }
      db.prepare(
        "INSERT INTO work_plan_step_task_links(plan_id,definition_revision,step_id,task_id,task_flow_id,linked_at) VALUES(?,?,?,?,?,?)",
      ).run(
        before.planId,
        before.definitionRevision,
        mutation.stepId,
        mutation.taskId,
        mutation.taskFlowId ?? null,
        now,
      );
      return;
    }
    if (mutation.action === "linkWorktree") {
      step(mutation.stepId);
      this.#assertLocalOwner(db, "worktree", mutation.worktreeId);
      const prior = db
        .prepare(
          "SELECT 1 AS ok FROM work_plan_step_worktree_links WHERE plan_id=? AND definition_revision=? AND step_id=? AND worktree_id=?",
        )
        .get(before.planId, before.definitionRevision, mutation.stepId, mutation.worktreeId);
      if (prior) {
        throw new WorkPlanConflictError(
          "worktree link already exists; replay requires the original idempotency key",
        );
      }
      db.prepare(
        "INSERT INTO work_plan_step_worktree_links(plan_id,definition_revision,step_id,worktree_id,linked_at) VALUES(?,?,?,?,?)",
      ).run(before.planId, before.definitionRevision, mutation.stepId, mutation.worktreeId, now);
      return;
    }
    if (mutation.action === "startAttempt") {
      const current = step(mutation.stepId);
      if (!new Set<WorkStepStatus>(["ready", "running", "waiting"]).has(current.status)) {
        throw new WorkPlanValidationError(
          "first attempt requires a ready, running, or waiting step",
        );
      }
      this.#assertLocalOwner(db, mutation.ownerType, mutation.ownerId);
      this.#assertOwnerAssociationAvailable(db, mutation.ownerType, mutation.ownerId);
      const existing = db
        .prepare(
          "SELECT 1 AS ok FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? AND step_id=?",
        )
        .get(before.planId, before.definitionRevision, mutation.stepId) as Row | undefined;
      if (existing) {
        throw new WorkPlanValidationError("use retryStep after an attempt already exists");
      }
      db.prepare(
        "INSERT INTO work_plan_step_attempts(attempt_id,plan_id,definition_revision,step_id,attempt_number,owner_type,owner_id,owner_state,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?)",
      ).run(
        mutation.attemptId,
        before.planId,
        before.definitionRevision,
        mutation.stepId,
        mutation.ownerType,
        mutation.ownerId,
        mutation.ownerType === "codex" || mutation.ownerType === "omx" ? "unknown" : "pending",
        now,
        now,
      );
      return;
    }
    if (mutation.action === "retryStep") {
      const current = step(mutation.stepId);
      if (!new Set(["failed", "cancelled"]).has(current.status)) {
        throw new WorkPlanValidationError("only failed or cancelled steps can retry");
      }
      this.#assertLocalOwner(db, mutation.ownerType, mutation.ownerId);
      this.#assertOwnerAssociationAvailable(db, mutation.ownerType, mutation.ownerId);
      const priorAttempt = db
        .prepare(
          "SELECT owner_state FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? AND step_id=? ORDER BY attempt_number DESC LIMIT 1",
        )
        .get(before.planId, before.definitionRevision, mutation.stepId) as Row | undefined;
      if (
        !priorAttempt ||
        !new Set(["failed", "cancelled", "lost"]).has(String(priorAttempt.owner_state))
      ) {
        throw new WorkPlanValidationError("retry requires the prior owner attempt to be terminal");
      }
      const number = Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(attempt_number),0)+1 AS n FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? AND step_id=?",
            )
            .get(before.planId, before.definitionRevision, mutation.stepId) as Row
        ).n,
      );
      db.prepare(
        "INSERT INTO work_plan_step_attempts(attempt_id,plan_id,definition_revision,step_id,attempt_number,owner_type,owner_id,owner_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        mutation.attemptId,
        before.planId,
        before.definitionRevision,
        mutation.stepId,
        number,
        mutation.ownerType,
        mutation.ownerId,
        "pending",
        now,
        now,
      );
      db.prepare(
        "UPDATE work_plan_steps SET status='ready',record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
      ).run(now, before.planId, before.definitionRevision, mutation.stepId);
      return;
    }
    if (mutation.action === "reconcileAttempt") {
      const attempt = db
        .prepare(
          "SELECT step_id,owner_state FROM work_plan_step_attempts WHERE attempt_id=? AND plan_id=?",
        )
        .get(mutation.attemptId, before.planId) as Row | undefined;
      if (!attempt) {
        throw new WorkPlanValidationError(`unknown attempt: ${mutation.attemptId}`);
      }
      const terminalOwnerStates = new Set(["succeeded", "failed", "cancelled", "lost"]);
      if (
        terminalOwnerStates.has(String(attempt.owner_state)) &&
        attempt.owner_state !== mutation.ownerState
      ) {
        throw new WorkPlanValidationError("terminal owner state cannot regress or change");
      }
      if (
        attempt.owner_state !== mutation.ownerState &&
        !OWNER_TRANSITIONS[String(attempt.owner_state)]?.has(mutation.ownerState)
      ) {
        throw new WorkPlanValidationError(
          `invalid owner transition: ${attempt.owner_state} -> ${mutation.ownerState}`,
        );
      }
      const coherentStepStatus: Record<string, WorkStepStatus> = {
        pending: "ready",
        running: "running",
        waiting: "waiting",
        succeeded: "succeeded",
        failed: "failed",
        lost: "failed",
        cancelled: "cancelled",
      };
      const expectedStepStatus = coherentStepStatus[mutation.ownerState];
      if (mutation.stepStatus && expectedStepStatus && mutation.stepStatus !== expectedStepStatus) {
        throw new WorkPlanValidationError(
          `owner state ${mutation.ownerState} requires step status ${expectedStepStatus}`,
        );
      }
      if (
        terminalOwnerStates.has(mutation.ownerState) &&
        mutation.stepStatus !== expectedStepStatus
      ) {
        throw new WorkPlanValidationError(
          `terminal owner state ${mutation.ownerState} requires coherent terminal step status`,
        );
      }
      db.prepare(
        "UPDATE work_plan_step_attempts SET owner_state=?,recovery_state=?,updated_at=?,ended_at=CASE WHEN ? IN ('succeeded','failed','cancelled','lost') THEN ? ELSE ended_at END WHERE attempt_id=?",
      ).run(
        mutation.ownerState,
        mutation.recoveryState ?? null,
        now,
        mutation.ownerState,
        now,
        mutation.attemptId,
      );
      if (mutation.stepStatus) {
        const current = step(String(attempt.step_id));
        if (!STEP_TRANSITIONS[current.status].has(mutation.stepStatus)) {
          throw new WorkPlanValidationError(
            `invalid step transition: ${current.status} -> ${mutation.stepStatus}`,
          );
        }
        db.prepare(
          "UPDATE work_plan_steps SET status=?,record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
        ).run(mutation.stepStatus, now, before.planId, before.definitionRevision, attempt.step_id);
      }
      this.#normalizeStoredReady(db, before.planId, before.definitionRevision, now);
      return;
    }
    if (mutation.action === "reconcileLocalOwners") {
      const attempts = db
        .prepare(
          "SELECT attempt_id,step_id,owner_type,owner_id,owner_state FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=?",
        )
        .all(before.planId, before.definitionRevision) as Row[];
      for (const attempt of attempts) {
        let ownerState = "unknown";
        let authorityAvailable = false;
        let authoritativeStepStatus: WorkStepStatus | undefined;
        if (attempt.owner_type === "task") {
          const owner = db
            .prepare("SELECT status FROM task_runs WHERE task_id=?")
            .get(attempt.owner_id) as Row | undefined;
          authorityAvailable = Boolean(owner);
          const status = String(owner?.status ?? "unknown");
          if (status === "blocked") {
            authoritativeStepStatus = "blocked";
          }
          ownerState =
            status === "queued"
              ? "pending"
              : status === "running"
                ? "running"
                : status === "waiting" || status === "blocked"
                  ? "waiting"
                  : status === "succeeded"
                    ? "succeeded"
                    : status === "cancelled"
                      ? "cancelled"
                      : status === "failed" || status === "lost" || status === "timed_out"
                        ? "failed"
                        : "unknown";
        } else if (attempt.owner_type === "task_flow") {
          const owner = db
            .prepare("SELECT status FROM flow_runs WHERE flow_id=?")
            .get(attempt.owner_id) as Row | undefined;
          authorityAvailable = Boolean(owner);
          const status = String(owner?.status ?? "unknown");
          if (status === "blocked") {
            authoritativeStepStatus = "blocked";
          }
          ownerState =
            status === "queued" || status === "pending"
              ? "pending"
              : status === "running"
                ? "running"
                : status === "waiting" || status === "blocked"
                  ? "waiting"
                  : status === "succeeded" || status === "completed"
                    ? "succeeded"
                    : status === "cancelled"
                      ? "cancelled"
                      : status === "failed" || status === "lost"
                        ? "failed"
                        : "unknown";
        }
        const priorOwnerState = String(attempt.owner_state);
        const current = step(String(attempt.step_id));
        if (
          !authorityAvailable &&
          !new Set(["succeeded", "failed", "cancelled", "lost"]).has(priorOwnerState)
        ) {
          db.prepare(
            "UPDATE work_plan_step_attempts SET owner_state='unknown',recovery_state='authority-unavailable-needs-reconcile',updated_at=? WHERE attempt_id=?",
          ).run(now, attempt.attempt_id);
          if (
            !new Set<WorkStepStatus>([
              "succeeded",
              "failed",
              "cancelled",
              "skipped",
              "superseded",
            ]).has(current.status) &&
            current.status !== "blocked"
          ) {
            db.prepare(
              "UPDATE work_plan_steps SET status='blocked',record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
            ).run(now, before.planId, before.definitionRevision, attempt.step_id);
          }
          continue;
        }
        if (
          ownerState === "unknown" &&
          new Set(["succeeded", "failed", "cancelled", "lost"]).has(priorOwnerState)
        ) {
          db.prepare(
            "UPDATE work_plan_step_attempts SET recovery_state='authority-unavailable-terminal-preserved',updated_at=? WHERE attempt_id=?",
          ).run(now, attempt.attempt_id);
          continue;
        }
        if (
          ownerState !== priorOwnerState &&
          !OWNER_TRANSITIONS[priorOwnerState]?.has(ownerState)
        ) {
          db.prepare(
            "UPDATE work_plan_step_attempts SET recovery_state='authority-transition-rejected',updated_at=? WHERE attempt_id=?",
          ).run(now, attempt.attempt_id);
          continue;
        }
        if (ownerState !== priorOwnerState) {
          db.prepare(
            "UPDATE work_plan_step_attempts SET owner_state=?,recovery_state='reconciled-after-restart',updated_at=?,ended_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE ended_at END WHERE attempt_id=?",
          ).run(ownerState, now, ownerState, now, attempt.attempt_id);
        }
        const target: WorkStepStatus | undefined =
          authoritativeStepStatus ??
          (ownerState === "pending"
            ? "ready"
            : ownerState === "running"
              ? "running"
              : ownerState === "waiting"
                ? "waiting"
                : ownerState === "succeeded"
                  ? "succeeded"
                  : ownerState === "failed"
                    ? "failed"
                    : ownerState === "cancelled"
                      ? "cancelled"
                      : undefined);
        if (
          target &&
          !new Set<WorkStepStatus>([
            "succeeded",
            "failed",
            "cancelled",
            "skipped",
            "superseded",
          ]).has(current.status) &&
          current.status !== target
        ) {
          db.prepare(
            "UPDATE work_plan_steps SET status=?,record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
          ).run(target, now, before.planId, before.definitionRevision, attempt.step_id);
        }
      }
      this.#normalizeStoredReady(db, before.planId, before.definitionRevision, now);
      return;
    }
    const structural = new Set(["splitStep", "mergeSteps", "replan"]);
    if (structural.has(mutation.action)) {
      const activeOwner = db
        .prepare(
          "SELECT 1 AS ok FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? AND owner_state IN ('pending','running','waiting') LIMIT 1",
        )
        .get(before.planId, before.definitionRevision);
      if (activeOwner) {
        throw new WorkPlanValidationError(
          "cannot structurally revise a definition with an active owner attempt",
        );
      }
    }
    let steps: WorkStepDefinition[] = before.steps.map((s) => ({
      stepId: s.stepId,
      title: s.title,
      status: s.status,
      dependsOn: s.dependsOn,
    }));
    let requirements: WorkRequirementDefinition[] = before.requirements;
    if (mutation.action === "splitStep") {
      step(mutation.stepId);
      const index = steps.findIndex((s) => s.stepId === mutation.stepId);
      const priorDeps = steps[index]?.dependsOn ?? [];
      const replacements = mutation.replacementSteps.map((s, i) => ({
        ...s,
        dependsOn:
          s.dependsOn ?? (i === 0 ? priorDeps : [mutation.replacementSteps[i - 1]!.stepId]),
      }));
      steps = steps.flatMap((s) =>
        s.stepId === mutation.stepId
          ? replacements
          : [
              {
                ...s,
                dependsOn: (s.dependsOn ?? []).flatMap((id) =>
                  id === mutation.stepId ? [replacements.at(-1)!.stepId] : [id],
                ),
              },
            ],
      );
      requirements = requirements.map((r) =>
        r.mappedStepId === mutation.stepId ? { ...r, mappedStepId: replacements[0]?.stepId } : r,
      );
    } else if (mutation.action === "mergeSteps") {
      if (mutation.stepIds.length < 2) {
        throw new WorkPlanValidationError("merge requires at least two steps");
      }
      mutation.stepIds.forEach(step);
      const merged = new Set(mutation.stepIds);
      const insertion = Math.min(...steps.map((s, i) => (merged.has(s.stepId) ? i : Infinity)));
      const dependencies = [
        ...new Set(
          steps
            .filter((s) => merged.has(s.stepId))
            .flatMap((s) => s.dependsOn ?? [])
            .filter((id) => !merged.has(id)),
        ),
      ];
      steps = steps
        .filter((s) => !merged.has(s.stepId))
        .map((s) => ({
          ...s,
          dependsOn: [
            ...new Set(
              (s.dependsOn ?? []).map((id) =>
                merged.has(id) ? mutation.replacementStep.stepId : id,
              ),
            ),
          ],
        }));
      steps.splice(insertion, 0, {
        ...mutation.replacementStep,
        dependsOn: mutation.replacementStep.dependsOn ?? dependencies,
      });
      requirements = requirements.map((r) =>
        r.mappedStepId && merged.has(r.mappedStepId)
          ? { ...r, mappedStepId: mutation.replacementStep.stepId }
          : r,
      );
    } else {
      steps = mutation.steps;
      requirements = mutation.requirements;
    }
    validateDefinition(steps, requirements);
    const nextRevision = before.definitionRevision + 1;
    db.prepare(
      "UPDATE work_plan_steps SET status='superseded',superseded_at=?,updated_at=? WHERE plan_id=? AND definition_revision=?",
    ).run(now, now, before.planId, before.definitionRevision);
    db.prepare("UPDATE work_plans SET definition_revision=?,display_cursor=0 WHERE plan_id=?").run(
      nextRevision,
      before.planId,
    );
    this.#insertDefinition(db, before.planId, nextRevision, steps, requirements, now);
  }
  #assertLocalOwner(db: DatabaseSync, ownerType: string, ownerId: string): void {
    const query =
      ownerType === "task"
        ? ["SELECT 1 AS ok FROM task_runs WHERE task_id=?", ownerId]
        : ownerType === "task_flow"
          ? ["SELECT 1 AS ok FROM flow_runs WHERE flow_id=?", ownerId]
          : ownerType === "worktree"
            ? ["SELECT 1 AS ok FROM worktrees WHERE id=? AND removed_at IS NULL", ownerId]
            : null;
    if (query && !db.prepare(String(query[0])).get(query[1])) {
      throw new WorkPlanValidationError(`${ownerType} owner not found: ${ownerId}`);
    }
  }
  #assertOwnerAssociationAvailable(db: DatabaseSync, ownerType: string, ownerId: string): void {
    const existing = db
      .prepare(
        "SELECT plan_id,step_id FROM work_plan_step_attempts WHERE owner_type=? AND owner_id=?",
      )
      .get(ownerType, ownerId) as Row | undefined;
    if (existing) {
      throw new WorkPlanConflictError(
        `owner run already associated with ${existing.plan_id}/${existing.step_id}`,
      );
    }
  }

  #normalizeStoredReady(db: DatabaseSync, planId: string, revision: number, now: number): void {
    const rows = db
      .prepare(
        "SELECT s.step_id,s.status,d.depends_on_step_id FROM work_plan_steps s LEFT JOIN work_plan_step_dependencies d ON d.plan_id=s.plan_id AND d.definition_revision=s.definition_revision AND d.step_id=s.step_id WHERE s.plan_id=? AND s.definition_revision=?",
      )
      .all(planId, revision) as Row[];
    const statuses = new Map(
      rows.map((r) => [String(r.step_id), String(r.status) as WorkStepStatus]),
    );
    const deps = new Map<string, string[]>();
    for (const r of rows) {
      if (r.depends_on_step_id) {
        deps.set(String(r.step_id), [
          ...(deps.get(String(r.step_id)) ?? []),
          String(r.depends_on_step_id),
        ]);
      }
    }
    for (const [id, status] of statuses) {
      if (status === "pending" || status === "ready") {
        const ready = (deps.get(id) ?? []).every((dependency) =>
          TERMINAL_PROGRESS.has(statuses.get(dependency) ?? "pending"),
        );
        const target = ready ? "ready" : "pending";
        if (target !== status) {
          db.prepare(
            "UPDATE work_plan_steps SET status=?,record_revision=record_revision+1,updated_at=? WHERE plan_id=? AND definition_revision=? AND step_id=?",
          ).run(target, now, planId, revision, id);
        }
      }
    }
  }
  #refreshCursor(db: DatabaseSync, planId: string): void {
    const plan = db
      .prepare("SELECT definition_revision,display_cursor FROM work_plans WHERE plan_id=?")
      .get(planId) as Row;
    const rows = db
      .prepare("SELECT status FROM work_plan_steps WHERE plan_id=? AND definition_revision=?")
      .all(planId, plan.definition_revision) as Row[];
    const completed = rows.filter((r) =>
      TERMINAL_PROGRESS.has(String(r.status) as WorkStepStatus),
    ).length;
    const cursor = Math.min(rows.length, Math.max(Number(plan.display_cursor), completed));
    db.prepare("UPDATE work_plans SET display_cursor=? WHERE plan_id=?").run(cursor, planId);
  }
  #load(db: DatabaseSync, planId: string): WorkPlanSnapshot {
    const plan = db
      .prepare(
        "SELECT p.*,j.primary_conversation_id,j.record_revision AS project_revision,g.objective,g.session_goal_id,g.record_revision AS goal_revision FROM work_plans p JOIN work_projects j ON j.project_id=p.project_id JOIN work_goals g ON g.goal_id=p.goal_id WHERE p.plan_id=?",
      )
      .get(planId) as Row | undefined;
    if (!plan) {
      throw new WorkPlanNotFoundError(`plan not found: ${planId}`);
    }
    const revision = Number(plan.definition_revision);
    const stepRows = db
      .prepare(
        "SELECT * FROM work_plan_steps WHERE plan_id=? AND definition_revision=? ORDER BY ordinal",
      )
      .all(planId, revision) as Row[];
    const dependencyRows = db
      .prepare(
        "SELECT step_id,depends_on_step_id FROM work_plan_step_dependencies WHERE plan_id=? AND definition_revision=?",
      )
      .all(planId, revision) as Row[];
    const taskRows = db
      .prepare(
        "SELECT step_id,task_id,task_flow_id FROM work_plan_step_task_links WHERE plan_id=? AND definition_revision=?",
      )
      .all(planId, revision) as Row[];
    const attemptRows = db
      .prepare(
        "SELECT * FROM work_plan_step_attempts WHERE plan_id=? AND definition_revision=? ORDER BY step_id,attempt_number",
      )
      .all(planId, revision) as Row[];
    const worktreeRows = db
      .prepare(
        "SELECT step_id,worktree_id FROM work_plan_step_worktree_links WHERE plan_id=? AND definition_revision=?",
      )
      .all(planId, revision) as Row[];
    const steps = stepRows.map((row) => ({
      stepId: String(row.step_id),
      title: String(row.title),
      ordinal: Number(row.ordinal),
      status: String(row.status) as WorkStepStatus,
      recordRevision: Number(row.record_revision),
      dependsOn: dependencyRows
        .filter((d) => d.step_id === row.step_id)
        .map((d) => String(d.depends_on_step_id)),
      taskLinks: taskRows
        .filter((t) => t.step_id === row.step_id)
        .map((t) => ({
          taskId: String(t.task_id),
          ...(t.task_flow_id ? { taskFlowId: String(t.task_flow_id) } : {}),
        })),
      worktreeLinks: worktreeRows
        .filter((link) => link.step_id === row.step_id)
        .map((link) => String(link.worktree_id)),
      attempts: attemptRows
        .filter((a) => a.step_id === row.step_id)
        .map((a) => ({
          attemptId: String(a.attempt_id),
          stepId: String(a.step_id),
          attemptNumber: Number(a.attempt_number),
          ownerType: String(a.owner_type) as never,
          ownerId: String(a.owner_id),
          ownerState: String(a.owner_state),
          ...(a.recovery_state ? { recoveryState: String(a.recovery_state) } : {}),
          createdAt: Number(a.created_at),
          updatedAt: Number(a.updated_at),
          ...(a.ended_at ? { endedAt: Number(a.ended_at) } : {}),
        })),
    }));
    const requirementRows = db
      .prepare(
        "SELECT * FROM work_plan_requirements WHERE plan_id=? AND definition_revision=? ORDER BY requirement_id",
      )
      .all(planId, revision) as Row[];
    const requirements = requirementRows.map((r) => ({
      requirementId: String(r.requirement_id),
      text: String(r.requirement_text),
      disposition: String(r.disposition) as never,
      ...(r.mapped_step_id ? { mappedStepId: String(r.mapped_step_id) } : {}),
      ...(r.exclusion_reason ? { exclusionReason: String(r.exclusion_reason) } : {}),
    }));
    const counts: WorkPlanProjection["statusCounts"] = {};
    for (const step of steps) {
      counts[step.status] = (counts[step.status] ?? 0) + 1;
    }
    const n = steps.length;
    const x = Math.min(n, Number(plan.display_cursor));
    return {
      schemaVersion: 1,
      projectId: String(plan.project_id),
      primaryConversationId: String(plan.primary_conversation_id),
      projectRecordRevision: Number(plan.project_revision),
      goal: {
        goalId: String(plan.goal_id),
        objective: String(plan.objective),
        ...(plan.session_goal_id ? { sessionGoalRef: String(plan.session_goal_id) } : {}),
        recordRevision: Number(plan.goal_revision),
      },
      planId,
      status: String(plan.status) as WorkPlanStatus,
      definitionRevision: revision,
      recordRevision: Number(plan.record_revision),
      createdAt: Number(plan.created_at),
      updatedAt: Number(plan.updated_at),
      steps,
      requirements,
      projection: {
        display: `Plan ${x}/${n}`,
        x,
        n,
        activeStepIds: steps.filter((s) => ACTIVE.has(s.status)).map((s) => s.stepId),
        readyStepIds: steps.filter((s) => s.status === "ready").map((s) => s.stepId),
        statusCounts: counts,
      },
    };
  }
}
