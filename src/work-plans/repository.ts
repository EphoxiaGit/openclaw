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
  type WorkPlanSnapshot,
  type WorkPlanStatus,
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
        "INSERT INTO work_goals(goal_id,project_id,objective,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run(input.goalId, input.projectId, input.objective, now, now);
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
      db.prepare(
        "INSERT INTO work_plans(plan_id,project_id,goal_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(input.planId, input.projectId, input.goalId, input.status ?? "draft", now, now);
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
        toStatus: input.status ?? "draft",
        action: "create",
        actorId: input.actorId,
        hash,
        payload: input,
        now,
      });
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

  history(planId: string): Row[] {
    return this.#db()
      .prepare("SELECT * FROM work_plan_transitions WHERE plan_id=? ORDER BY sequence")
      .all(planId) as Row[];
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
      "INSERT INTO work_plan_transitions(transition_id,project_id,plan_id,definition_revision,entity_type,from_status,to_status,action,actor_id,request_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      input.projectId,
      input.planId ?? null,
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
      db.prepare(
        "INSERT OR IGNORE INTO work_plan_step_task_links(plan_id,definition_revision,step_id,task_id,task_flow_id,linked_at) VALUES(?,?,?,?,?,?)",
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
    if (mutation.action === "retryStep") {
      const current = step(mutation.stepId);
      if (!new Set(["failed", "cancelled"]).has(current.status)) {
        throw new WorkPlanValidationError("only failed or cancelled steps can retry");
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
        .prepare("SELECT step_id FROM work_plan_step_attempts WHERE attempt_id=? AND plan_id=?")
        .get(mutation.attemptId, before.planId) as Row | undefined;
      if (!attempt) {
        throw new WorkPlanValidationError(`unknown attempt: ${mutation.attemptId}`);
      }
      db.prepare(
        "UPDATE work_plan_step_attempts SET owner_state=?,recovery_state=?,updated_at=?,ended_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE ended_at END WHERE attempt_id=?",
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
    db.prepare("UPDATE work_plans SET definition_revision=? WHERE plan_id=?").run(
      nextRevision,
      before.planId,
    );
    this.#insertDefinition(db, before.planId, nextRevision, steps, requirements, now);
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
        "SELECT p.*,j.primary_conversation_id,j.record_revision AS project_revision,g.objective,g.record_revision AS goal_revision FROM work_plans p JOIN work_projects j ON j.project_id=p.project_id JOIN work_goals g ON g.goal_id=p.goal_id WHERE p.plan_id=?",
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
