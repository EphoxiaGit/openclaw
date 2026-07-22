import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ProjectContextRepository } from "../../work-plans/project-context-repository.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { createWorkPlansHandlers } from "./work-plans.js";

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
    context: {},
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
