import { describe, expect, it } from "vitest";
import {
  validateWorkCapsulesUpdateParams,
  validateWorkDocumentsGetResult,
  validateWorkPlansCreateParams,
  validateWorkPlansCreateResult,
  validateWorkPlansGetResult,
  validateWorkPlansHistoryResult,
  validateWorkPlansMutateParams,
  validateWorkPlansMutateResult,
  validateWorkPlansProjectionResult,
  validateWorkProjectsCreateParams,
  validateWorkProjectsCreateRegisteredParams,
  validateWorkProjectsCreateResult,
  validateWorkProjectsGetResult,
  validateWorkProjectsListResult,
  validateWorkRegisteredProjectsGetResult,
  validateWorkRegisteredProjectsListParams,
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

  it("accepts only opaque registered-project context mutations", () => {
    expect(validateWorkRegisteredProjectsListParams({})).toBe(true);
    expect(
      validateWorkProjectsCreateRegisteredParams({
        registeredProjectId: "glass",
        objective: "Ship",
        idempotencyKey: "once",
      }),
    ).toBe(true);
    expect(
      validateWorkCapsulesUpdateParams({
        projectId: "project-1",
        expectedRevision: 1,
        idempotencyKey: "capsule-1",
        content: {
          summary: "Summary",
          currentFocus: "Focus",
          constraints: [],
          decisions: [],
          openQuestions: [],
          conflicts: [],
          explicitNextTask: "Next",
        },
        provenance: [
          { sourceType: "registered_document", sourceId: "constraints", sourceRevision: 1 },
        ],
      }),
    ).toBe(true);
    for (const forbidden of [
      { repoRoot: "/private" },
      { repositoryLocator: "ssh://private" },
      { command: "rm -rf" },
      { model: "arbitrary" },
      { sessionId: "forged" },
      { worktreeId: "forged" },
      { capabilities: ["shell"] },
      { actorId: "client-forged" },
    ]) {
      expect(
        validateWorkProjectsCreateRegisteredParams({
          registeredProjectId: "glass",
          objective: "Ship",
          idempotencyKey: "once",
          ...forbidden,
        }),
      ).toBe(false);
    }
    expect(
      validateWorkProjectsCreateRegisteredParams({
        registeredProjectId: "../private",
        objective: "Ship",
        idempotencyKey: "once",
      }),
    ).toBe(false);
  });

  it("rejects locator-bearing public results", () => {
    const registeredProject = {
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1",
      defaultConversationId: "conversation-main",
      recordRevision: 1,
      updatedAt: 1,
      repositories: [
        {
          repositoryId: "main",
          displayName: "Main",
          active: true,
          primary: true,
          recordRevision: 1,
        },
      ],
      documents: [],
    };
    expect(validateWorkRegisteredProjectsGetResult({ project: registeredProject })).toBe(true);
    expect(
      validateWorkRegisteredProjectsGetResult({
        project: {
          ...registeredProject,
          repositories: [{ ...registeredProject.repositories[0], serverLocator: "/private" }],
        },
      }),
    ).toBe(false);
    expect(
      validateWorkDocumentsGetResult({
        document: {
          documentId: "capsule",
          kind: "capsule",
          revision: 1,
          immutable: false,
          content: {
            summary: "Summary",
            currentFocus: "Focus",
            constraints: [],
            decisions: [],
            openQuestions: [],
            conflicts: [],
            explicitNextTask: "Next",
          },
          provenance: [],
          createdAt: 1,
          locator: "/private",
        },
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
