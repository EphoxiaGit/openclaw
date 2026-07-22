import { describe, expect, it } from "vitest";
import {
  validateWorkCapsulesUpdateParams,
  validateWorkCheckpointsCreateResult,
  validateWorkDocumentsGetResult,
  validateWorkHandoffsCreateResult,
  validateWorkPlansCreateParams,
  validateWorkPlansCreateResult,
  validateWorkPlansGetResult,
  validateWorkPlansHistoryResult,
  validateWorkPlansMutateParams,
  validateWorkPlansMutateResult,
  validateWorkPlansProjectionResult,
  validateWorkProjectContextGetResult,
  validateWorkProjectsCreateParams,
  validateWorkProjectsCreateRegisteredParams,
  validateWorkProjectsCreateRegisteredResult,
  validateWorkProjectsCreateResult,
  validateWorkProjectsGetResult,
  validateWorkProjectsListResult,
  validateWorkRegisteredProjectsGetResult,
  validateWorkRegisteredProjectsListParams,
  validateWorkRegisteredProjectsListResult,
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
    const capsuleUpdate = {
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
        { sourceType: "registered_document" as const, sourceId: "constraints", sourceRevision: 1 },
      ],
    };
    expect(validateWorkCapsulesUpdateParams(capsuleUpdate)).toBe(true);
    expect(validateWorkCapsulesUpdateParams({ ...capsuleUpdate, actorId: "client-forged" })).toBe(
      false,
    );
    for (const forbidden of [
      { repoRoot: "/private" },
      { repositoryLocator: "ssh://private" },
      { command: "rm -rf" },
      { model: "arbitrary" },
      { sessionId: "forged" },
      { sessionGoalRef: "forged" },
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

  it("validates registered list, create, context, checkpoint, and handoff results", () => {
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
    } as const;
    expect(validateWorkRegisteredProjectsListResult({ projects: [registeredProject] })).toBe(true);
    expect(
      validateWorkProjectsCreateRegisteredResult({
        registeredProjectId: "glass",
        projectId: "project-1",
        goalId: "goal-1",
        primaryConversationId: "conversation-main",
        recordRevision: 1,
      }),
    ).toBe(true);
    expect(
      validateWorkProjectContextGetResult({
        context: {
          project: {
            projectId: "project-1",
            primaryConversationId: "conversation-main",
            recordRevision: 1,
            updatedAt: 1,
          },
          registeredProject,
          goal: { goalId: "goal-1", objective: "Ship", recordRevision: 1 },
          plans: [],
        },
      }),
    ).toBe(true);
    const checkpoint = {
      documentId: "checkpoint-1",
      kind: "checkpoint",
      revision: 1,
      immutable: true,
      content: {
        objective: "Ship",
        progress: [],
        files: [],
        tests: [],
        blockers: [],
        exactNextAction: "Continue",
        plans: [],
      },
      provenance: [],
      createdAt: 1,
    } as const;
    expect(
      validateWorkCheckpointsCreateResult({ document: checkpoint, projectRecordRevision: 2 }),
    ).toBe(true);
    expect(
      validateWorkHandoffsCreateResult({
        document: {
          documentId: "handoff-1",
          kind: "handoff",
          revision: 1,
          immutable: true,
          content: {
            checkpointDocumentId: "checkpoint-1",
            objective: "Ship",
            progress: [],
            blockers: [],
            exactNextAction: "Continue",
          },
          provenance: [
            { sourceType: "project_document", sourceId: "checkpoint-1", sourceRevision: 1 },
          ],
          createdAt: 1,
        },
        projectRecordRevision: 3,
      }),
    ).toBe(true);
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
