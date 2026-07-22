import { describe, expect, it } from "vitest";
import {
  validateWorkPlansCreateParams,
  validateWorkPlansCreateResult,
  validateWorkPlansGetResult,
  validateWorkPlansHistoryResult,
  validateWorkPlansMutateParams,
  validateWorkPlansMutateResult,
  validateWorkPlansProjectionResult,
  validateWorkProjectsCreateParams,
  validateWorkProjectsCreateResult,
  validateWorkProjectsGetResult,
  validateWorkProjectsListResult,
} from "./index.js";

describe("work-plan gateway validation", () => {
  it("accepts bounded project and plan mutations", () => {
    expect(
      validateWorkProjectsCreateParams({
        projectId: "p",
        goalId: "g",
        primaryConversationId: "s",
        objective: "Ship",
        idempotencyKey: "i",
      }),
    ).toBe(true);
    expect(
      validateWorkPlansCreateParams({
        projectId: "p",
        planId: "plan",
        goalId: "g",
        expectedRevision: 1,
        idempotencyKey: "i",
        steps: [{ stepId: "s1", title: "One" }],
      }),
    ).toBe(true);
    expect(
      validateWorkPlansMutateParams({
        projectId: "p",
        planId: "plan",
        expectedRevision: 1,
        idempotencyKey: "i",
        mutation: {
          action: "retryStep",
          stepId: "s1",
          attemptId: "attempt",
          ownerType: "task",
          ownerId: "opaque",
        },
      }),
    ).toBe(true);
  });

  it("rejects unknown fields, open statuses, and missing CAS/idempotency", () => {
    expect(
      validateWorkProjectsCreateParams({
        projectId: "p",
        goalId: "g",
        primaryConversationId: "s",
        objective: "Ship",
        idempotencyKey: "i",
        actorId: "client-forged",
        repoRoot: "/private",
      }),
    ).toBe(false);
    expect(
      validateWorkPlansMutateParams({
        projectId: "p",
        planId: "plan",
        mutation: { action: "setStepStatus", stepId: "s", status: "done" },
      }),
    ).toBe(false);
  });

  it("exports typed result validators for every work RPC", () => {
    expect(
      validateWorkProjectsCreateResult({ projectId: "p", goalId: "g", recordRevision: 1 }),
    ).toBe(true);
    expect(validateWorkProjectsListResult({ projects: [] })).toBe(true);
    for (const validator of [
      validateWorkProjectsGetResult,
      validateWorkPlansCreateResult,
      validateWorkPlansGetResult,
      validateWorkPlansMutateResult,
      validateWorkPlansHistoryResult,
      validateWorkPlansProjectionResult,
    ]) {
      expect(typeof validator).toBe("function");
    }
  });
});
