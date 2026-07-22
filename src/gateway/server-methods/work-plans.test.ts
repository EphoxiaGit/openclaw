import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { ProjectContextRepository } from "../../work-plans/project-context-repository.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import type { WorkPlanSnapshot } from "../../work-plans/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { createWorkPlansHandlers, projectWorkPlanWorkers } from "./work-plans.js";

const dirs: string[] = [];

function options(
  method: string,
  params: Record<string, unknown>,
  respond: GatewayRequestHandlerOptions["respond"],
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "request-1", method, params },
    params,
    client: { connect: { device: { id: "trusted-device" } } },
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions;
}

async function invoke(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown }> {
  let response: { ok: boolean; payload?: unknown } | undefined;
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler(
    options(method, params, (ok, payload) => {
      response = { ok, payload };
    }),
  );
  if (!response) {
    throw new Error(`handler did not respond: ${method}`);
  }
  return response;
}

afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("work-plan worker projection", () => {
  it("joins attempts to display-safe task and session facts with stable parentage", () => {
    const plan = {
      schemaVersion: 1,
      projectId: "project",
      primaryConversationId: "conversation",
      projectRecordRevision: 1,
      goal: { goalId: "goal", objective: "Ship", recordRevision: 1 },
      planId: "plan",
      status: "running",
      definitionRevision: 1,
      recordRevision: 1,
      createdAt: 10,
      updatedAt: 20,
      steps: [
        {
          stepId: "step-parent",
          title: "Research",
          ordinal: 1,
          status: "running",
          recordRevision: 1,
          dependsOn: [],
          taskLinks: [],
          worktreeLinks: [],
          attempts: [
            {
              attemptId: "private-attempt-parent",
              stepId: "step-parent",
              attemptNumber: 1,
              ownerType: "task",
              ownerId: "private-task-parent",
              ownerState: "running",
              createdAt: 100,
              updatedAt: 200,
            },
          ],
        },
        {
          stepId: "step-child",
          title: "Implement",
          ordinal: 2,
          status: "succeeded",
          recordRevision: 1,
          dependsOn: ["step-parent"],
          taskLinks: [],
          worktreeLinks: [],
          attempts: [
            {
              attemptId: "private-attempt-child",
              stepId: "step-child",
              attemptNumber: 1,
              ownerType: "task",
              ownerId: "private-task-child",
              ownerState: "succeeded",
              createdAt: 120,
              updatedAt: 220,
              endedAt: 220,
            },
          ],
        },
      ],
      requirements: [],
      projection: {
        display: "Plan 1/2",
        x: 1,
        n: 2,
        activeStepIds: ["step-parent"],
        readyStepIds: [],
        statusCounts: { running: 1, succeeded: 1 },
      },
    } satisfies WorkPlanSnapshot;
    const task = (overrides: Partial<TaskRecord>): TaskRecord => ({
      taskId: "private-task-parent",
      runtime: "subagent",
      requesterSessionKey: "private-requester-session",
      ownerKey: "private-owner",
      scopeKind: "session",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 100,
      task: "private prompt",
      ...overrides,
    });
    const workers = projectWorkPlanWorkers({
      plan,
      now: 300,
      tasks: [
        task({
          label: "Research worker",
          agentId: "researcher",
          childSessionKey: "private-child-session-parent",
          progressSummary: "Comparing native seams.",
        }),
        task({
          taskId: "private-task-child",
          parentTaskId: "private-task-parent",
          status: "succeeded",
          label: "Implementation worker",
          agentId: "executor",
          childSessionKey: "private-child-session-child",
          startedAt: 120,
          endedAt: 220,
          terminalSummary: "Implemented the bounded slice.",
        }),
      ],
      resolveSessionFacts: () => ({
        provider: "openai",
        model: "gpt-5.6-sol",
        runtime: "codex",
        contextPercent: 42,
      }),
    });

    expect(workers).toEqual([
      expect.objectContaining({
        key: "worker-1-1",
        ownerKind: "isolated",
        role: "researcher",
        lane: "subagent",
        state: "running",
        health: "busy",
        canCancel: true,
        canRetry: false,
      }),
      expect.objectContaining({
        key: "worker-2-1",
        parentKey: "worker-1-1",
        state: "succeeded",
        result: "Implemented the bounded slice.",
        canCancel: false,
      }),
    ]);
    const rendered = JSON.stringify(workers);
    for (const privateValue of [
      "private-task-parent",
      "private-task-child",
      "private-child-session",
      "private-attempt",
      "private-owner",
      "private prompt",
    ]) {
      expect(rendered).not.toContain(privateValue);
    }
  });

  it("cancels the authoritative task through an opaque worker key", async () => {
    const dbPath = path.join(makeTempDir(dirs, "work-plan-worker-cancel-"), "state.sqlite");
    const repository = new WorkPlanRepository({ path: dbPath, now: () => 100 });
    const project = repository.createProject({
      projectId: "project-cancel",
      primaryConversationId: "agent:main:main",
      goalId: "goal-cancel",
      objective: "Ship",
      idempotencyKey: "create-project",
      actorId: "test",
    });
    const plan = repository.createPlan({
      projectId: project.projectId,
      planId: "plan-cancel",
      goalId: project.goalId,
      expectedRevision: project.recordRevision,
      idempotencyKey: "create-plan",
      actorId: "test",
      status: "running",
      steps: [{ stepId: "step-cancel", title: "Run task" }],
    });
    repository.mutate({
      projectId: project.projectId,
      planId: plan.planId,
      expectedRevision: plan.recordRevision,
      idempotencyKey: "start-attempt",
      actorId: "test",
      mutation: {
        action: "startAttempt",
        stepId: "step-cancel",
        attemptId: "attempt-cancel",
        ownerType: "task",
        ownerId: "private-task-id",
      },
    });
    const task: TaskRecord = {
      taskId: "private-task-id",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "private-owner",
      scopeKind: "session",
      task: "private prompt",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 100,
    };
    const cancelTask = vi.fn(async () => ({ found: true, cancelled: true, task }));
    const handlers = createWorkPlansHandlers({
      repository,
      listTasks: () => [task],
      cancelTask,
    });

    expect(
      await invoke(handlers, "work.workers.cancel", {
        sessionKey: "agent:main:main",
        workerKey: "worker-0-1",
      }),
    ).toEqual({ ok: true, payload: { found: true, cancelled: true } });
    expect(cancelTask).toHaveBeenCalledWith({
      cfg: {},
      taskId: "private-task-id",
      reason: "Stopped from Assistant.",
    });
  });
});

describe("project-context gateway mutations", () => {
  it("persists the authenticated device actor and rejects forged actor/session-goal fields", async () => {
    const dbPath = path.join(makeTempDir(dirs, "work-plans-handler-"), "state.sqlite");
    const projectContextRepository = new ProjectContextRepository({ path: dbPath, now: () => 100 });
    const repository = new WorkPlanRepository({ path: dbPath, now: () => 100 });
    projectContextRepository.putTrustedRegisteredProject({
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1",
      defaultConversationId: "conversation-main",
      expectedRevision: 0,
      idempotencyKey: "register",
      actorId: "server:registration",
      repositories: [
        {
          repositoryId: "main",
          displayName: "Main",
          serverLocator: "/private/main",
          active: true,
          primary: true,
        },
      ],
      documents: [],
    });
    const project = projectContextRepository.createRegisteredWorkProject({
      registeredProjectId: "glass",
      objective: "Ship",
      idempotencyKey: "create-project",
      actorId: "server:create",
    });
    const handlers = createWorkPlansHandlers({ repository, projectContextRepository });
    const update = await invoke(handlers, "work.capsules.update", {
      projectId: project.projectId,
      expectedRevision: 1,
      idempotencyKey: "capsule",
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
    });
    expect(update.ok).toBe(true);
    expect(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT actor_id FROM work_plan_transitions WHERE project_id=? AND action='update_capsule'",
        )
        .get(project.projectId),
    ).toEqual({ actor_id: "device:trusted-device" });

    expect(
      await invoke(handlers, "work.capsules.update", {
        projectId: project.projectId,
        expectedRevision: 2,
        idempotencyKey: "forged-actor",
        actorId: "device:forged",
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
      }),
    ).toMatchObject({ ok: false });
    expect(
      await invoke(handlers, "work.projects.createRegistered", {
        registeredProjectId: "glass",
        objective: "Rejected",
        idempotencyKey: "forged-session-goal",
        sessionGoalRef: "forged-session-goal",
      }),
    ).toMatchObject({ ok: false });
    expect(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare("SELECT COUNT(*) AS count FROM work_plan_transitions WHERE project_id=?")
        .get(project.projectId),
    ).toEqual({ count: 2 });
  });
});
