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
    expect(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare("SELECT session_goal_id FROM work_goals WHERE project_id=?")
        .get(project.projectId),
    ).toEqual({ session_goal_id: null });
    const audit = JSON.stringify(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT result_json,payload_json FROM registered_project_mutation_receipts r JOIN registered_project_transitions t ON t.registered_project_id=r.registered_project_id WHERE r.registered_project_id='glass'",
        )
        .all(),
    );
    expect(audit).not.toMatch(/server\/private|ssh:|CONSTRAINTS\.md|serverLocator/);
  });

  it("isolates registered receipts from caller-chosen G004 project identities and operations", () => {
    const dbPath = path.join(makeTempDir(dirs, "project-context-receipts-"), "state.sqlite");
    const context = new ProjectContextRepository({ path: dbPath });
    const plans = new WorkPlanRepository({ path: dbPath });
    plans.createProject({
      projectId: "registered:glass",
      goalId: "legacy-goal",
      primaryConversationId: "legacy-conversation",
      objective: "Legacy collision",
      idempotencyKey: "same-key",
      actorId: "legacy:actor",
    });
    context.putTrustedRegisteredProject({
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1",
      defaultConversationId: "conversation-main",
      expectedRevision: 0,
      idempotencyKey: "same-key",
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
    const created = context.createRegisteredWorkProject({
      registeredProjectId: "glass",
      objective: "Registered work",
      idempotencyKey: "same-key",
      actorId: "server:create",
    });
    expect(created.projectId).toMatch(/^project-/);
    const db = openOpenClawStateDatabase({ path: dbPath }).db;
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM work_plan_mutation_receipts WHERE project_id='registered:glass'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT operation_scope FROM registered_project_mutation_receipts WHERE registered_project_id='glass' ORDER BY operation_scope",
        )
        .all(),
    ).toEqual([{ operation_scope: "create_work_project" }, { operation_scope: "registration" }]);
    expect(
      db
        .prepare(
          "SELECT action,actor_id FROM registered_project_transitions WHERE registered_project_id='glass'",
        )
        .all(),
    ).toEqual([{ action: "create", actor_id: "server:registration" }]);
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
        repositories: [{ ...base.repositories[0]!, active: false }],
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      context.putTrustedRegisteredProject({
        ...base,
        repositories: [
          ...base.repositories,
          {
            ...base.repositories[0]!,
            repositoryId: "inactive-primary",
            active: false,
          },
        ],
      }),
    ).toThrow(WorkPlanValidationError);
    expect(() =>
      context.putTrustedRegisteredProject({
        ...base,
        repositories: [
          ...base.repositories,
          {
            ...base.repositories[0]!,
            repositoryId: "inactive",
            active: false,
            primary: false,
          },
        ],
        documents: [
          {
            documentId: "inactive-doc",
            repositoryId: "inactive",
            kind: "other",
            label: "Inactive",
            serverLocator: "doc.md",
          },
        ],
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
    expect(() =>
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "INSERT INTO registered_project_repositories(registered_project_id,repository_id,display_name,server_locator,active,is_primary,ordinal,created_at,updated_at) VALUES('glass','invalid','Invalid','internal',0,1,1,1,1)",
        )
        .run(),
    ).toThrow();
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

  it("re-resolves capsule provenance and refuses checkpoints after plan advancement", () => {
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
    const capsuleResult = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: plan.projectRecordRevision,
      idempotencyKey: "capsule-plan",
      actorId: "operator:test",
      content: capsule(),
      provenance: [
        {
          sourceType: "work_plan",
          sourceId: plan.planId,
          sourceRevision: plan.recordRevision,
        },
      ],
    });
    plans.mutate({
      projectId: project.projectId,
      planId: plan.planId,
      expectedRevision: plan.recordRevision,
      idempotencyKey: "advance-plan",
      actorId: "operator:test",
      mutation: { action: "setPlanStatus", status: "ready" },
    });
    expect(context.getProjectContext(project.projectId).capsuleProvenance).toEqual({
      state: "stale",
      staleRefs: [
        { sourceType: "work_plan", sourceId: plan.planId, sourceRevision: plan.recordRevision },
      ],
    });
    expect(() =>
      context.createCheckpoint({
        projectId: project.projectId,
        expectedRevision: capsuleResult.projectRecordRevision,
        idempotencyKey: "stale-checkpoint",
        actorId: "operator:test",
      }),
    ).toThrow(/stale provenance/);
  });

  it("tombstones registered documents so removal and re-add cannot validate old provenance", () => {
    const { context, dbPath, project } = fixture();
    const firstCapsule = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: 1,
      idempotencyKey: "capsule-doc-v1",
      actorId: "operator:test",
      content: capsule(),
      provenance: [
        { sourceType: "registered_document", sourceId: "constraints", sourceRevision: 1 },
      ],
    });
    const repositories = [
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
    ];
    context.putTrustedRegisteredProject({
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1",
      defaultConversationId: "conversation-main",
      expectedRevision: 1,
      idempotencyKey: "remove-doc",
      actorId: "server:test",
      repositories,
      documents: [],
    });
    expect(context.getRegisteredProject("glass").documents).toEqual([]);
    expect(
      openOpenClawStateDatabase({ path: dbPath })
        .db.prepare(
          "SELECT active,record_revision FROM registered_project_documents WHERE registered_project_id='glass' AND document_id='constraints'",
        )
        .get(),
    ).toEqual({ active: 0, record_revision: 2 });
    const readded = context.putTrustedRegisteredProject({
      registeredProjectId: "glass",
      displayName: "Glass",
      enabled: true,
      profile: "repo-planning-v1",
      defaultConversationId: "conversation-main",
      expectedRevision: 2,
      idempotencyKey: "readd-doc",
      actorId: "server:test",
      repositories,
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
    expect(readded.documents[0]?.recordRevision).toBe(3);
    expect(context.getProjectContext(project.projectId).capsuleProvenance).toEqual({
      state: "stale",
      staleRefs: [
        { sourceType: "registered_document", sourceId: "constraints", sourceRevision: 1 },
      ],
    });
    expect(() =>
      context.createCheckpoint({
        projectId: project.projectId,
        expectedRevision: firstCapsule.projectRecordRevision,
        idempotencyKey: "stale-doc-checkpoint",
        actorId: "operator:test",
      }),
    ).toThrow(/stale provenance/);
    expect(() =>
      context.updateCapsule({
        projectId: project.projectId,
        expectedRevision: firstCapsule.projectRecordRevision,
        idempotencyKey: "old-doc-provenance",
        actorId: "operator:test",
        content: capsule("Still stale"),
        provenance: [
          { sourceType: "registered_document", sourceId: "constraints", sourceRevision: 1 },
        ],
      }),
    ).toThrow(/stale, foreign, or unknown/);
  });

  it("keeps exact immutable project-document revisions current and rejects foreign or missing refs", () => {
    const { context, project } = fixture();
    const first = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: 1,
      idempotencyKey: "capsule-first",
      actorId: "operator:test",
      content: capsule("First"),
      provenance: [],
    });
    const second = context.updateCapsule({
      projectId: project.projectId,
      expectedRevision: first.projectRecordRevision,
      idempotencyKey: "capsule-second",
      actorId: "operator:test",
      content: capsule("Second"),
      provenance: [{ sourceType: "project_document", sourceId: "capsule", sourceRevision: 1 }],
    });
    expect(context.getProjectContext(project.projectId).capsuleProvenance).toEqual({
      state: "current",
      staleRefs: [],
    });
    const checkpoint = context.createCheckpoint({
      projectId: project.projectId,
      expectedRevision: second.projectRecordRevision,
      idempotencyKey: "derived-capsule-checkpoint",
      actorId: "operator:test",
    });
    expect(checkpoint.document.kind).toBe("checkpoint");

    const other = context.createRegisteredWorkProject({
      registeredProjectId: "glass",
      objective: "Other project",
      idempotencyKey: "other-exact-project",
      actorId: "operator:test",
    });
    const otherCheckpoint = context.createCheckpoint({
      projectId: other.projectId,
      expectedRevision: 1,
      idempotencyKey: "other-exact-checkpoint",
      actorId: "operator:test",
    });
    for (const [idempotencyKey, provenance] of [
      [
        "foreign-project-document",
        [
          {
            sourceType: "project_document" as const,
            sourceId: otherCheckpoint.document.documentId,
            sourceRevision: 1,
          },
        ],
      ],
      [
        "missing-project-document-revision",
        [{ sourceType: "project_document" as const, sourceId: "capsule", sourceRevision: 99 }],
      ],
    ] as const) {
      expect(() =>
        context.updateCapsule({
          projectId: project.projectId,
          expectedRevision: checkpoint.projectRecordRevision,
          idempotencyKey,
          actorId: "operator:test",
          content: capsule("Rejected"),
          provenance: [...provenance],
        }),
      ).toThrow(/stale, foreign, or unknown/);
    }
  });

  it("bounds checkpoint plans, progress, and provenance to the same 50 most-recent plans", () => {
    const { context, dbPath, project } = fixture();
    const db = openOpenClawStateDatabase({ path: dbPath }).db;
    const insert = db.prepare(
      "INSERT INTO work_plans(plan_id,project_id,goal_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    );
    for (let index = 0; index < 55; index += 1) {
      insert.run(
        `plan-${String(index).padStart(2, "0")}`,
        project.projectId,
        project.goalId,
        "draft",
        index,
        index,
      );
    }
    const checkpoint = context.createCheckpoint({
      projectId: project.projectId,
      expectedRevision: 1,
      idempotencyKey: "bounded-checkpoint",
      actorId: "operator:test",
    });
    expect(checkpoint.document.kind).toBe("checkpoint");
    if (checkpoint.document.kind !== "checkpoint") {
      throw new Error("expected checkpoint");
    }
    expect(checkpoint.document.content.plans).toHaveLength(50);
    expect(checkpoint.document.content.progress).toHaveLength(50);
    expect(checkpoint.document.provenance).toHaveLength(50);
    expect(checkpoint.document.content.plans[0]?.planId).toBe("plan-54");
    expect(checkpoint.document.content.plans.some((plan) => plan.planId === "plan-00")).toBe(false);
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
