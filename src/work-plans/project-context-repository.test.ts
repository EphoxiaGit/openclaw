import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ProjectContextRepository } from "./project-context-repository.js";
import { WorkPlanRepository } from "./repository.js";
import { WorkPlanConflictError, WorkPlanValidationError } from "./types.js";

const dirs: string[] = [];
const capsule = (next = "Implement the next slice") => ({
  summary: "Trusted project context",
  currentFocus: "Build G005",
  constraints: ["No arbitrary paths"],
  decisions: ["Use repo-planning-v1"],
  openQuestions: [],
  conflicts: [],
  explicitNextTask: next,
});

function fixture(now: () => number = () => 100) {
  const dbPath = path.join(makeTempDir(dirs, "project-context-"), "state.sqlite");
  const context = new ProjectContextRepository({ path: dbPath, now });
  const plans = new WorkPlanRepository({ path: dbPath, now });
  const registered = context.putTrustedRegisteredProject({
    registeredProjectId: "glass",
    displayName: "Glass",
    enabled: true,
    profile: "repo-planning-v1",
    defaultConversationId: "conversation-main",
    expectedRevision: 0,
    idempotencyKey: "register-glass",
    actorId: "server:fixture",
    repositories: [
      {
        repositoryId: "main",
        displayName: "Main",
        serverLocator: "/server/private/main",
        active: true,
        primary: true,
      },
      {
        repositoryId: "docs",
        displayName: "Docs",
        serverLocator: "ssh://private/docs",
        active: true,
        primary: false,
      },
    ],
    documents: [
      {
        documentId: "constraints",
        repositoryId: "main",
        kind: "constraints",
        label: "Constraints",
        serverLocator: "docs/CONSTRAINTS.md",
      },
    ],
  });
  const project = context.createRegisteredWorkProject({
    registeredProjectId: "glass",
    objective: "Ship trusted project context",
    idempotencyKey: "create-work-project",
    actorId: "server:fixture",
  });
  return { context, plans, dbPath, registered, project };
}

afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("registered project context", () => {
  it("additively preserves existing G004 project rows", () => {
    const dbPath = path.join(makeTempDir(dirs, "project-context-migration-"), "state.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE work_projects (
        project_id TEXT NOT NULL PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        primary_conversation_id TEXT NOT NULL,
        record_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO work_projects(project_id,primary_conversation_id,created_at,updated_at)
      VALUES('legacy-project','legacy-conversation',1,1);
    `);
    legacy.close();
    const row = openOpenClawStateDatabase({ path: dbPath })
      .db.prepare(
        "SELECT project_id,primary_conversation_id,registered_project_id FROM work_projects WHERE project_id='legacy-project'",
      )
      .get();
    expect(row).toEqual({
      project_id: "legacy-project",
      primary_conversation_id: "legacy-conversation",
      registered_project_id: null,
    });
  });

  it("keeps trusted locators internal and derives opaque work identities and conversation", () => {
    const { context, dbPath, registered, project } = fixture();
    expect(registered.repositories).toHaveLength(2);
    expect(project).toMatchObject({
      registeredProjectId: "glass",
      primaryConversationId: "conversation-main",
      recordRevision: 1,
    });
    expect(project.projectId).toMatch(/^project-/);
    expect(project.goalId).toMatch(/^goal-/);
    expect(JSON.stringify(context.listRegisteredProjects())).not.toMatch(
      /server\/private|ssh:|CONSTRAINTS\.md|serverLocator/,
    );
    const raw = openOpenClawStateDatabase({ path: dbPath })
      .db.prepare(
        "SELECT server_locator FROM registered_project_repositories WHERE registered_project_id='glass' AND repository_id='main'",
      )
      .get();
    expect(raw).toEqual({ server_locator: "/server/private/main" });
    const audit = JSON.stringify(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT result_json,payload_json FROM work_plan_mutation_receipts r JOIN work_plan_transitions t ON t.project_id=r.project_id WHERE r.project_id='registered:glass'",
        )
        .all(),
    );
    expect(audit).not.toMatch(/server\/private|ssh:|CONSTRAINTS\.md|serverLocator/);
  });

  it("enforces fixed profiles, opaque document identifiers, active registration, and one primary", () => {
    const dbPath = path.join(makeTempDir(dirs, "project-context-invalid-"), "state.sqlite");
    const context = new ProjectContextRepository({ path: dbPath });
    const base = {
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1" as const,
      defaultConversationId: "conversation-main",
      expectedRevision: 0,
      idempotencyKey: "register",
      actorId: "server:test",
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
    };
    expect(() =>
      context.putTrustedRegisteredProject({
        ...base,
        profile: "arbitrary" as never,
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      context.putTrustedRegisteredProject({
        ...base,
        repositories: [...base.repositories, { ...base.repositories[0]!, repositoryId: "other" }],
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      context.putTrustedRegisteredProject({
        ...base,
        documents: [
          {
            documentId: "../secret",
            repositoryId: "main",
            kind: "other",
            label: "Bad",
            serverLocator: "secret",
          },
        ],
      }),
    ).toThrow(WorkPlanValidationError);
    const disabledRequest = { ...base, enabled: false };
    const disabled = context.putTrustedRegisteredProject(disabledRequest);
    expect(context.putTrustedRegisteredProject(disabledRequest)).toEqual(disabled);
    expect(() =>
      context.putTrustedRegisteredProject({ ...disabledRequest, displayName: "Mismatch" }),
    ).toThrow(WorkPlanConflictError);
    expect(() =>
      context.createRegisteredWorkProject({
        registeredProjectId: "glass",
        objective: "Denied",
        idempotencyKey: "denied",
        actorId: "server:test",
      }),
    ).toThrow(/disabled/);
    expect(() => context.getRegisteredProject("unknown")).toThrow(/not found/);
  });

  it("uses shared CAS, receipts, and audit without leaking locators", () => {
    const { context, plans, dbPath, project } = fixture();
    const plan = plans.createPlan({
      projectId: project.projectId,
      goalId: project.goalId,
      planId: "plan-1",
      expectedRevision: 1,
      idempotencyKey: "create-plan",
      actorId: "operator:test",
      steps: [{ stepId: "step-1", title: "Implement" }],
    });
    const request = {
      projectId: project.projectId,
      expectedRevision: plan.projectRecordRevision,
      idempotencyKey: "capsule-1",
      actorId: "device:trusted",
      content: capsule(),
      provenance: [
        { sourceType: "work_plan" as const, sourceId: "plan-1", sourceRevision: 1 },
        {
          sourceType: "registered_document" as const,
          sourceId: "constraints",
          sourceRevision: 1,
        },
      ],
    };
    const first = context.updateCapsule(request);
    expect(context.updateCapsule(request)).toEqual(first);
    expect(() => context.updateCapsule({ ...request, content: capsule("Different") })).toThrow(
      WorkPlanConflictError,
    );
    expect(() =>
      plans.createPlan({
        projectId: project.projectId,
        goalId: project.goalId,
        planId: "stale-plan",
        expectedRevision: plan.projectRecordRevision,
        idempotencyKey: "stale-plan",
        actorId: "operator:test",
        steps: [{ stepId: "step", title: "Stale" }],
      }),
    ).toThrow(WorkPlanConflictError);
    const stored = JSON.stringify(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT result_json,payload_json,actor_id FROM work_plan_mutation_receipts r JOIN work_plan_transitions t ON t.project_id=r.project_id WHERE r.project_id=?",
        )
        .all(project.projectId),
    );
    expect(stored).not.toMatch(/server\/private|ssh:|CONSTRAINTS\.md|serverLocator/);
    expect(stored).toContain("device:trusted");
  });

  it("rejects stale, unknown, and cross-project provenance atomically", () => {
    const { context, plans, project } = fixture();
    const plan = plans.createPlan({
      projectId: project.projectId,
      goalId: project.goalId,
      planId: "plan-1",
      expectedRevision: 1,
      idempotencyKey: "create-plan",
      actorId: "operator:test",
      steps: [{ stepId: "step-1", title: "Implement" }],
    });
    const other = context.createRegisteredWorkProject({
      registeredProjectId: "glass",
      objective: "Other",
      idempotencyKey: "other-project",
      actorId: "server:test",
    });
    const otherPlan = plans.createPlan({
      projectId: other.projectId,
      goalId: other.goalId,
      planId: "other-plan",
      expectedRevision: 1,
      idempotencyKey: "other-plan",
      actorId: "operator:test",
      steps: [{ stepId: "step", title: "Other" }],
    });
    const base = {
      projectId: project.projectId,
      expectedRevision: plan.projectRecordRevision,
      actorId: "operator:test",
      content: capsule(),
    };
    for (const [idempotencyKey, provenance] of [
      ["stale", [{ sourceType: "work_plan", sourceId: "plan-1", sourceRevision: 99 }]],
      ["unknown", [{ sourceType: "registered_document", sourceId: "missing", sourceRevision: 1 }]],
      [
        "foreign",
        [
          {
            sourceType: "work_plan",
            sourceId: otherPlan.planId,
            sourceRevision: otherPlan.recordRevision,
          },
        ],
      ],
    ] as const) {
      expect(() =>
        context.updateCapsule({ ...base, idempotencyKey, provenance: [...provenance] }),
      ).toThrow(WorkPlanValidationError);
    }
    expect(context.listDocuments(project.projectId)).toEqual([]);
  });

  it("creates immutable sequenced checkpoints and same-project handoffs", () => {
    const { context, dbPath, project } = fixture(() => 100);
    const capsuleOne = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: 1,
      idempotencyKey: "capsule-one",
      actorId: "operator:test",
      content: capsule("First next action"),
      provenance: [],
    });
    const firstCheckpoint = context.createCheckpoint({
      projectId: project.projectId,
      expectedRevision: capsuleOne.projectRecordRevision,
      idempotencyKey: "checkpoint-one",
      actorId: "operator:test",
    });
    const capsuleTwo = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: firstCheckpoint.projectRecordRevision,
      idempotencyKey: "capsule-two",
      actorId: "operator:test",
      content: capsule("Second next action"),
      provenance: [
        {
          sourceType: "project_document",
          sourceId: firstCheckpoint.document.documentId,
          sourceRevision: 1,
        },
      ],
    });
    const secondCheckpoint = context.createCheckpoint({
      projectId: project.projectId,
      expectedRevision: capsuleTwo.projectRecordRevision,
      idempotencyKey: "checkpoint-two",
      actorId: "operator:test",
    });
    const projection = context.getProjectContext(project.projectId);
    expect(projection.latestCheckpoint?.documentId).toBe(secondCheckpoint.document.documentId);
    expect(projection.latestCheckpoint?.content.exactNextAction).toBe("Second next action");
    const handoff = context.createHandoff({
      projectId: project.projectId,
      checkpointDocumentId: secondCheckpoint.document.documentId,
      expectedRevision: secondCheckpoint.projectRecordRevision,
      idempotencyKey: "handoff",
      actorId: "operator:test",
    });
    expect(handoff.document).toMatchObject({ kind: "handoff", revision: 1, immutable: true });
    expect(() =>
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare("UPDATE project_documents SET content_json='{}' WHERE document_id=?")
        .run(handoff.document.documentId),
    ).toThrow(/immutable project document/);
    expect(() =>
      context.createHandoff({
        projectId: project.projectId,
        checkpointDocumentId: "capsule",
        expectedRevision: handoff.projectRecordRevision,
        idempotencyKey: "bad-handoff",
        actorId: "operator:test",
      }),
    ).toThrow(/checkpoint/);
  });
});
