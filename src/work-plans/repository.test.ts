import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("durable work plans", () => {
  it("persists schema state, reopens, and computes parallel ready Plan X/N projection", () => {
    const { repository, dbPath, plan } = fixture();
    expect(plan.projection).toMatchObject({ display: "Plan 0/3", readyStepIds: ["a"] });
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
      idempotencyKey: "fail-a",
      actorId: "operator-1",
      mutation: { action: "setStepStatus", stepId: "a", status: "failed" },
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
        ownerType: "task",
        ownerId: "task-existing",
      },
    });
    expect(current.steps[0]?.attempts).toHaveLength(1);
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
      idempotencyKey: "fail",
      actorId: "operator-1",
      mutation: { action: "setStepStatus", stepId: "a", status: "failed" },
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
});
