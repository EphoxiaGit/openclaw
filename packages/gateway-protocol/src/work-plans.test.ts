import { describe, expect, it } from "vitest";
import {
  validateWorkPlansCreateParams,
  validateWorkPlansMutateParams,
  validateWorkProjectsCreateParams,
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
        actorId: "a",
      }),
    ).toBe(true);
    expect(
      validateWorkPlansCreateParams({
        projectId: "p",
        planId: "plan",
        goalId: "g",
        expectedRevision: 1,
        idempotencyKey: "i",
        actorId: "a",
        steps: [{ stepId: "s1", title: "One" }],
      }),
    ).toBe(true);
    expect(
      validateWorkPlansMutateParams({
        projectId: "p",
        planId: "plan",
        expectedRevision: 1,
        idempotencyKey: "i",
        actorId: "a",
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
        actorId: "a",
        repoRoot: "/private",
      }),
    ).toBe(false);
    expect(
      validateWorkPlansMutateParams({
        projectId: "p",
        planId: "plan",
        actorId: "a",
        mutation: { action: "setStepStatus", stepId: "s", status: "done" },
      }),
    ).toBe(false);
  });
});
