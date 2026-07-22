import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { WorkPlanRepository } from "./repository.js";
import { WorkPlanConflictError, WorkPlanValidationError } from "./types.js";

const dirs: string[] = [];
function fixture() {
  const dbPath = path.join(makeTempDir(dirs, "work-plans-"), "state.sqlite");
  let now = 100;
  const repository = new WorkPlanRepository({ path: dbPath, now: () => ++now });
  repository.createProject({
    projectId: "project-1",
    goalId: "goal-1",
    primaryConversationId: "session-1",
    sessionGoalRef: "session-goal-1",
    objective: "Ship the bounded plan",
    idempotencyKey: "create-project",
    actorId: "operator-1",
  });
  const plan = repository.createPlan({
    projectId: "project-1",
    planId: "plan-1",
    goalId: "goal-1",
    expectedRevision: 1,
    idempotencyKey: "create-plan",
    actorId: "operator-1",
    status: "ready",
    steps: [
      { stepId: "a", title: "A" },
      { stepId: "b", title: "B", dependsOn: ["a"] },
      { stepId: "c", title: "C", dependsOn: ["a"] },
    ],
    requirements: [
      { requirementId: "r1", text: "Cover B", disposition: "mapped", mappedStepId: "b" },
      { requirementId: "r2", text: "Deferred", disposition: "unresolved" },
    ],
  });
  return { repository, dbPath, plan };
}
function seedTask(dbPath: string, taskId: string): void {
  openOpenClawStateDatabase({ path: dbPath })
    .db.prepare(
      "INSERT INTO task_runs(task_id,runtime,owner_key,scope_kind,task,status,delivery_status,notify_policy,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      taskId,
      "subagent",
      "owner",
      "global",
      "synthetic",
      "running",
      "not_applicable",
      "none",
      1,
    );
}
function seedWorktree(dbPath: string, worktreeId: string): void {
  openOpenClawStateDatabase({ path: dbPath })
    .db.prepare(
      "INSERT INTO worktrees(id,repo_fingerprint,repo_root,path,branch,base_ref,owner_kind,created_at,last_active_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      worktreeId,
      "synthetic",
      "/synthetic",
      "/synthetic/worktree",
      "branch",
      "base",
      "manual",
      1,
      1,
    );
}
function seedFlow(dbPath: string, flowId: string, status: string): void {
  openOpenClawStateDatabase({ path: dbPath })
    .db.prepare(
      "INSERT INTO flow_runs(flow_id,sync_mode,owner_key,revision,status,notify_policy,goal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(flowId, "managed", "owner", 0, status, "none", "synthetic", 1, 1);
}
afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("durable work plans", () => {
  it("persists schema state, reopens, and computes parallel ready Plan X/N projection", () => {
    const { repository, dbPath, plan } = fixture();
    expect(plan.projection).toMatchObject({ display: "Plan 0/3", readyStepIds: ["a"] });
    expect(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT origin_session_key,session_goal_id FROM work_goals WHERE goal_id='goal-1'",
        )
        .get(),
    ).toMatchObject({ origin_session_key: "session-1", session_goal_id: "session-goal-1" });
    const next = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "finish-a",
      actorId: "operator-1",
      mutation: { action: "setStepStatus", stepId: "a", status: "succeeded" },
    });
    expect(next.projection).toMatchObject({ display: "Plan 1/3", readyStepIds: ["b", "c"] });
    closeOpenClawStateDatabaseForTest();
    expect(new WorkPlanRepository({ path: dbPath }).getPlan("plan-1")).toEqual(next);
  });

  it("returns exact idempotent replays and atomically rejects stale or mismatched writes", () => {
    const { repository, plan } = fixture();
    const request = {
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "once",
      actorId: "operator-1",
      mutation: { action: "setPlanStatus", status: "running" },
    } as const;
    const first = repository.mutate(request);
    expect(repository.mutate(request)).toEqual(first);
    const historyCount = repository.history("plan-1").length;
    expect(() =>
      repository.mutate({ ...request, mutation: { action: "setPlanStatus", status: "blocked" } }),
    ).toThrow(WorkPlanConflictError);
    expect(() =>
      repository.mutate({
        ...request,
        idempotencyKey: "stale",
        mutation: { action: "setPlanStatus", status: "blocked" },
      }),
    ).toThrow(WorkPlanConflictError);
    expect(repository.getPlan("plan-1").status).toBe("running");
    expect(repository.history("plan-1")).toHaveLength(historyCount);
  });

  it("rejects cycles and invalid requirement coverage without partial structural revisions", () => {
    const { repository, plan } = fixture();
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: plan.recordRevision,
        idempotencyKey: "cycle",
        actorId: "operator-1",
        mutation: {
          action: "replan",
          steps: [
            { stepId: "x", title: "X", dependsOn: ["y"] },
            { stepId: "y", title: "Y", dependsOn: ["x"] },
          ],
          requirements: [],
        },
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: plan.recordRevision,
        idempotencyKey: "coverage",
        actorId: "operator-1",
        mutation: {
          action: "replan",
          steps: [{ stepId: "x", title: "X" }],
          requirements: [
            { requirementId: "r", text: "R", disposition: "mapped", mappedStepId: "missing" },
          ],
        },
      }),
    ).toThrow(WorkPlanValidationError);
    expect(repository.getPlan("plan-1").definitionRevision).toBe(1);
  });

  it("enforces explicit lifecycle transitions and plan completion coverage", () => {
    const { repository, plan } = fixture();
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: plan.recordRevision,
        idempotencyKey: "early-complete",
        actorId: "operator-1",
        mutation: { action: "setPlanStatus", status: "completed" },
      }),
    ).toThrow(WorkPlanValidationError);
    const succeeded = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "succeed-a",
      actorId: "operator-1",
      mutation: { action: "setStepStatus", stepId: "a", status: "succeeded" },
    });
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: succeeded.recordRevision,
        idempotencyKey: "revive-a",
        actorId: "operator-1",
        mutation: { action: "setStepStatus", stepId: "a", status: "running" },
      }),
    ).toThrow(WorkPlanValidationError);
  });

  it("retains superseded definitions and attempt history across retry, split, merge, and replan", () => {
    const { repository, plan } = fixture();
    let current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "start-a",
      actorId: "operator-1",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "attempt-0",
        ownerType: "external",
        ownerId: "first-owner",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "fail-a",
      actorId: "operator-1",
      mutation: {
        action: "reconcileAttempt",
        attemptId: "attempt-0",
        ownerState: "failed",
        stepStatus: "failed",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "retry-a",
      actorId: "operator-1",
      mutation: {
        action: "retryStep",
        stepId: "a",
        attemptId: "attempt-1",
        ownerType: "external",
        ownerId: "task-existing",
      },
    });
    expect(current.steps[0]?.attempts).toHaveLength(2);
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "finish-retry-a",
      actorId: "operator-1",
      mutation: {
        action: "reconcileAttempt",
        attemptId: "attempt-1",
        ownerState: "failed",
        stepStatus: "failed",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "split-b",
      actorId: "operator-1",
      mutation: {
        action: "splitStep",
        stepId: "b",
        replacementSteps: [
          { stepId: "b1", title: "B1" },
          { stepId: "b2", title: "B2" },
        ],
      },
    });
    expect(current.definitionRevision).toBe(2);
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "merge-b",
      actorId: "operator-1",
      mutation: {
        action: "mergeSteps",
        stepIds: ["b1", "b2"],
        replacementStep: { stepId: "bm", title: "B merged" },
      },
    });
    expect(current.steps.map((step) => step.stepId)).toContain("bm");
    expect(repository.history("plan-1").map((row) => row.action)).toEqual(
      expect.arrayContaining(["retryStep", "splitStep", "mergeSteps"]),
    );
  });

  it("reconciles an external owner once and advances to N/N without owning the task", () => {
    const { repository, plan } = fixture();
    let current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "first-run",
      actorId: "operator-1",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "first-attempt",
        ownerType: "external",
        ownerId: "first-run-owner",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "fail",
      actorId: "operator-1",
      mutation: {
        action: "reconcileAttempt",
        attemptId: "first-attempt",
        ownerState: "failed",
        stepStatus: "failed",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "retry",
      actorId: "operator-1",
      mutation: {
        action: "retryStep",
        stepId: "a",
        attemptId: "attempt",
        ownerType: "external",
        ownerId: "opaque-owner",
      },
    });
    const reconcile = {
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "reconcile",
      actorId: "operator-1",
      mutation: {
        action: "reconcileAttempt",
        attemptId: "attempt",
        ownerState: "succeeded",
        recoveryState: "verified",
        stepStatus: "succeeded",
      },
    } as const;
    current = repository.mutate(reconcile);
    expect(repository.mutate(reconcile)).toEqual(current);
    for (const id of ["b", "c"]) {
      current = repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: current.recordRevision,
        idempotencyKey: `finish-${id}`,
        actorId: "operator-1",
        mutation: { action: "setStepStatus", stepId: id, status: "succeeded" },
      });
    }
    expect(current.projection.display).toBe("Plan 3/3");
  });

  it("creates a first attempt, rejects dangling local owners, and recovers unavailable owners idempotently after reopen", () => {
    const { repository, dbPath, plan } = fixture();
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: plan.recordRevision,
        idempotencyKey: "dangling",
        actorId: "operator",
        mutation: {
          action: "startAttempt",
          stepId: "a",
          attemptId: "bad",
          ownerType: "task",
          ownerId: "missing-task",
        },
      }),
    ).toThrow(WorkPlanValidationError);
    const started = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "first-attempt",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "codex-attempt",
        ownerType: "codex",
        ownerId: "opaque-run",
      },
    });
    expect(started.steps[0]?.attempts).toMatchObject([{ attemptNumber: 1, ownerState: "unknown" }]);
    closeOpenClawStateDatabaseForTest();
    const reopened = new WorkPlanRepository({ path: dbPath });
    const recovery = {
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: started.recordRevision,
      idempotencyKey: "restart-reconcile",
      actorId: "system:recovery",
      mutation: { action: "reconcileLocalOwners" },
    } as const;
    const reconciled = reopened.mutate(recovery);
    expect(reopened.mutate(recovery)).toEqual(reconciled);
    expect(reconciled.steps[0]?.attempts[0]).toMatchObject({ ownerState: "unknown" });
    expect(reopened.history("plan-1").at(-1)?.action).toBe("reconcileLocalOwners");
  });

  it("resets Plan X/N on replan and forbids structural/link mutations after completion", () => {
    const { repository, plan } = fixture();
    let current = plan;
    for (const id of ["a", "b", "c"]) {
      current = repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: current.recordRevision,
        idempotencyKey: `done-${id}`,
        actorId: "operator",
        mutation: { action: "setStepStatus", stepId: id, status: "succeeded" },
      });
    }
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "fresh-plan",
      actorId: "operator",
      mutation: {
        action: "replan",
        steps: [
          { stepId: "x", title: "X" },
          { stepId: "y", title: "Y", dependsOn: ["x"] },
        ],
        requirements: [],
      },
    });
    expect(current.projection.display).toBe("Plan 0/2");
    for (const id of ["x", "y"]) {
      current = repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: current.recordRevision,
        idempotencyKey: `done-new-${id}`,
        actorId: "operator",
        mutation: { action: "setStepStatus", stepId: id, status: "succeeded" },
      });
    }
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "running",
      actorId: "operator",
      mutation: { action: "setPlanStatus", status: "running" },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "complete",
      actorId: "operator",
      mutation: { action: "setPlanStatus", status: "completed" },
    });
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: current.recordRevision,
        idempotencyKey: "terminal-replan",
        actorId: "operator",
        mutation: { action: "replan", steps: [{ stepId: "z", title: "Z" }], requirements: [] },
      }),
    ).toThrow(WorkPlanValidationError);
    const terminal = repository.createPlan({
      projectId: "project-1",
      planId: "valid-terminal",
      goalId: "goal-1",
      expectedRevision: plan.projectRecordRevision,
      idempotencyKey: "valid-terminal",
      actorId: "operator",
      status: "completed",
      steps: [{ stepId: "terminal-step", title: "Done", status: "succeeded" }],
    });
    expect(terminal.projection.display).toBe("Plan 1/1");
  });

  it("requires the selected goal to belong to the project", () => {
    const { repository, plan } = fixture();
    repository.createProject({
      projectId: "project-2",
      goalId: "goal-2",
      primaryConversationId: "session-2",
      objective: "Other",
      idempotencyKey: "project-2",
      actorId: "operator",
    });
    expect(() =>
      repository.createPlan({
        projectId: "project-1",
        planId: "wrong-goal",
        goalId: "goal-2",
        expectedRevision: plan.projectRecordRevision,
        idempotencyKey: "wrong-goal",
        actorId: "operator",
        steps: [{ stepId: "x", title: "X" }],
      }),
    ).toThrow(WorkPlanValidationError);
  });

  it("retains link lineage, rejects conflicting relinks, and records the affected step", () => {
    const { repository, dbPath, plan } = fixture();
    seedTask(dbPath, "task-1");
    let linked = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "link",
      actorId: "operator",
      mutation: { action: "linkTask", stepId: "a", taskId: "task-1" },
    });
    expect(
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: plan.recordRevision,
        idempotencyKey: "link",
        actorId: "operator",
        mutation: { action: "linkTask", stepId: "a", taskId: "task-1" },
      }),
    ).toEqual(linked);
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: linked.recordRevision,
        idempotencyKey: "relink",
        actorId: "operator",
        mutation: { action: "linkTask", stepId: "a", taskId: "task-1" },
      }),
    ).toThrow(WorkPlanConflictError);
    linked = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: linked.recordRevision,
      idempotencyKey: "split-linked",
      actorId: "operator",
      mutation: {
        action: "splitStep",
        stepId: "a",
        replacementSteps: [
          { stepId: "a1", title: "A1" },
          { stepId: "a2", title: "A2" },
        ],
      },
    });
    expect(repository.lineage("plan-1").taskLinks).toMatchObject([
      { definitionRevision: 1, stepId: "a", taskId: "task-1" },
    ]);
    expect(repository.history("plan-1").find((row) => row.action === "linkTask")?.stepId).toBe("a");
    expect(linked.definitionRevision).toBe(2);
  });

  it("prevents duplicate owner associations and structural changes while an owner is active", () => {
    const { repository, plan } = fixture();
    const started = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "owner",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "owner-attempt",
        ownerType: "external",
        ownerId: "owner-run",
      },
    });
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: started.recordRevision,
        idempotencyKey: "active-replan",
        actorId: "operator",
        mutation: { action: "replan", steps: [{ stepId: "x", title: "X" }], requirements: [] },
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: started.recordRevision,
        idempotencyKey: "manual-terminal",
        actorId: "operator",
        mutation: { action: "setStepStatus", stepId: "a", status: "succeeded" },
      }),
    ).toThrow(WorkPlanValidationError);
    const succeeded = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: started.recordRevision,
      idempotencyKey: "owner-step-done",
      actorId: "operator",
      mutation: {
        action: "reconcileAttempt",
        attemptId: "owner-attempt",
        ownerState: "succeeded",
        stepStatus: "succeeded",
      },
    });
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: succeeded.recordRevision,
        idempotencyKey: "duplicate-owner",
        actorId: "operator",
        mutation: {
          action: "startAttempt",
          stepId: "b",
          attemptId: "duplicate",
          ownerType: "external",
          ownerId: "owner-run",
        },
      }),
    ).toThrow(WorkPlanConflictError);
  });

  it("links a worktree resource without consuming the step run-attempt slot", () => {
    const { repository, dbPath, plan } = fixture();
    seedWorktree(dbPath, "worktree-1");
    const linked = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "link-worktree",
      actorId: "operator",
      mutation: { action: "linkWorktree", stepId: "a", worktreeId: "worktree-1" },
    });
    const started = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: linked.recordRevision,
      idempotencyKey: "run-after-worktree",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "run-after-worktree",
        ownerType: "codex",
        ownerId: "codex-run",
      },
    });
    expect(started.steps[0]).toMatchObject({
      worktreeLinks: ["worktree-1"],
      attempts: [{ attemptId: "run-after-worktree" }],
    });
    expect(repository.lineage("plan-1").worktreeLinks).toMatchObject([
      { worktreeId: "worktree-1", stepId: "a" },
    ]);
  });

  it("reconciles blocked flows distinctly and marks missing nonterminal authority unavailable", () => {
    const { repository, dbPath, plan } = fixture();
    seedFlow(dbPath, "flow-blocked", "waiting");
    let current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "flow-attempt",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "flow-attempt",
        ownerType: "task_flow",
        ownerId: "flow-blocked",
      },
    });
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "flow-waiting-reconcile",
      actorId: "system:recovery",
      mutation: { action: "reconcileLocalOwners" },
    });
    expect(current.steps[0]).toMatchObject({
      status: "waiting",
      attempts: [{ ownerState: "waiting" }],
    });
    openOpenClawStateDatabase({ path: dbPath })
      .db.prepare("UPDATE flow_runs SET status='blocked' WHERE flow_id='flow-blocked'")
      .run();
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "flow-blocked-reconcile",
      actorId: "system:recovery",
      mutation: { action: "reconcileLocalOwners" },
    });
    expect(current.steps[0]).toMatchObject({
      status: "blocked",
      attempts: [{ ownerState: "waiting" }],
    });
    openOpenClawStateDatabase({ path: dbPath })
      .db.prepare("UPDATE flow_runs SET status='completed' WHERE flow_id='flow-blocked'")
      .run();
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "flow-complete-reconcile",
      actorId: "system:recovery",
      mutation: { action: "reconcileLocalOwners" },
    });
    expect(current.steps[0]?.status).toBe("succeeded");
    seedFlow(dbPath, "flow-missing", "running");
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "missing-attempt",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "b",
        attemptId: "missing-attempt",
        ownerType: "task_flow",
        ownerId: "flow-missing",
      },
    });
    openOpenClawStateDatabase({ path: dbPath })
      .db.prepare("DELETE FROM flow_runs WHERE flow_id='flow-missing'")
      .run();
    current = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: current.recordRevision,
      idempotencyKey: "missing-reconcile",
      actorId: "system:recovery",
      mutation: { action: "reconcileLocalOwners" },
    });
    expect(current.steps.find((step) => step.stepId === "b")).toMatchObject({
      status: "blocked",
      attempts: [{ ownerState: "unknown", recoveryState: "authority-unavailable-needs-reconcile" }],
    });
  });

  it("rejects incoherent terminal creation and owner reconciliation", () => {
    const { repository, plan } = fixture();
    expect(() =>
      repository.createPlan({
        projectId: "project-1",
        planId: "bad-terminal",
        goalId: "goal-1",
        expectedRevision: plan.projectRecordRevision,
        idempotencyKey: "bad-terminal",
        actorId: "operator",
        status: "completed",
        steps: [{ stepId: "x", title: "X" }],
      }),
    ).toThrow(WorkPlanValidationError);
    const started = repository.mutate({
      projectId: "project-1",
      planId: "plan-1",
      expectedRevision: plan.recordRevision,
      idempotencyKey: "coherent-owner",
      actorId: "operator",
      mutation: {
        action: "startAttempt",
        stepId: "a",
        attemptId: "coherent-attempt",
        ownerType: "external",
        ownerId: "coherent-run",
      },
    });
    expect(() =>
      repository.mutate({
        projectId: "project-1",
        planId: "plan-1",
        expectedRevision: started.recordRevision,
        idempotencyKey: "bad-coherence",
        actorId: "operator",
        mutation: {
          action: "reconcileAttempt",
          attemptId: "coherent-attempt",
          ownerState: "succeeded",
          stepStatus: "failed",
        },
      }),
    ).toThrow(WorkPlanValidationError);
  });
});
