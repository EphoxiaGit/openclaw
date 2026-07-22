import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  PROJECT_PROFILE,
  type ProjectCapsule,
  type ProjectCheckpoint,
  type ProjectContextProjection,
  type ProjectDocument,
  type ProjectDocumentProvenance,
  type ProjectHandoff,
  type RegisteredDocumentKind,
  type RegisteredProjectView,
  type TrustedRegisteredProjectInput,
} from "./project-context-types.js";
import {
  WorkPlanConflictError,
  WorkPlanNotFoundError,
  WorkPlanValidationError,
  type WorkPlanStatus,
} from "./types.js";

type RepositoryOptions = OpenClawStateDatabaseOptions & { now?: () => number };
type Row = Record<string, string | number | null>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function requireText(value: string, name: string): void {
  if (!value.trim()) {
    throw new WorkPlanValidationError(`${name} must be non-empty`);
  }
}

function requireSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) {
    throw new WorkPlanValidationError(`${name} must be an opaque identifier`);
  }
}

function validateRegistration(input: TrustedRegisteredProjectInput): void {
  requireSafeId(input.registeredProjectId, "registeredProjectId");
  requireText(input.displayName, "displayName");
  requireSafeId(input.defaultConversationId, "defaultConversationId");
  if (input.profile !== PROJECT_PROFILE) {
    throw new WorkPlanValidationError(`unsupported project profile: ${input.profile}`);
  }
  if (input.repositories.length === 0) {
    throw new WorkPlanValidationError("a registered project requires a repository");
  }
  const primaryRepositories = input.repositories.filter((repository) => repository.primary);
  if (primaryRepositories.length !== 1 || !primaryRepositories[0]?.active) {
    throw new WorkPlanValidationError(
      "a registered project requires exactly one primary repository",
    );
  }
  const repositoryIds = new Set<string>();
  const activeRepositoryIds = new Set<string>();
  for (const repository of input.repositories) {
    requireSafeId(repository.repositoryId, "repositoryId");
    requireText(repository.displayName, "repository displayName");
    requireText(repository.serverLocator, "serverLocator");
    if (repositoryIds.has(repository.repositoryId)) {
      throw new WorkPlanValidationError(`duplicate repository: ${repository.repositoryId}`);
    }
    repositoryIds.add(repository.repositoryId);
    if (repository.active) {
      activeRepositoryIds.add(repository.repositoryId);
    }
  }
  const documentIds = new Set<string>();
  for (const document of input.documents) {
    requireSafeId(document.documentId, "documentId");
    requireText(document.label, "document label");
    requireText(document.serverLocator, "document serverLocator");
    if (!activeRepositoryIds.has(document.repositoryId)) {
      throw new WorkPlanValidationError(
        `document repository is unknown or inactive: ${document.repositoryId}`,
      );
    }
    if (documentIds.has(document.documentId)) {
      throw new WorkPlanValidationError(`duplicate registered document: ${document.documentId}`);
    }
    documentIds.add(document.documentId);
  }
}

export class ProjectContextRepository {
  readonly #options: RepositoryOptions;

  constructor(options: RepositoryOptions = {}) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #db(): DatabaseSync {
    return openOpenClawStateDatabase(this.#options).db;
  }

  putTrustedRegisteredProject(input: TrustedRegisteredProjectInput): RegisteredProjectView {
    validateRegistration(input);
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#registeredReceipt(
        db,
        input.registeredProjectId,
        "registration",
        input.idempotencyKey,
        hash,
      );
      if (replay) {
        return replay as RegisteredProjectView;
      }
      const existing = db
        .prepare("SELECT record_revision FROM registered_projects WHERE registered_project_id=?")
        .get(input.registeredProjectId) as Row | undefined;
      if (existing) {
        if (Number(existing.record_revision) !== input.expectedRevision) {
          throw new WorkPlanConflictError("stale registered project revision");
        }
        const updated = db
          .prepare(
            "UPDATE registered_projects SET display_name=?,enabled=?,profile=?,default_conversation_id=?,record_revision=record_revision+1,updated_at=? WHERE registered_project_id=? AND record_revision=?",
          )
          .run(
            input.displayName,
            input.enabled ? 1 : 0,
            input.profile,
            input.defaultConversationId,
            now,
            input.registeredProjectId,
            input.expectedRevision,
          );
        if (updated.changes !== 1) {
          throw new WorkPlanConflictError("stale registered project revision");
        }
      } else {
        if (input.expectedRevision !== 0) {
          throw new WorkPlanConflictError("registered project does not exist at expected revision");
        }
        db.prepare(
          "INSERT INTO registered_projects(registered_project_id,display_name,enabled,profile,default_conversation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          input.registeredProjectId,
          input.displayName,
          input.enabled ? 1 : 0,
          input.profile,
          input.defaultConversationId,
          now,
          now,
        );
      }

      const oldRepositories = new Map(
        (
          db
            .prepare("SELECT * FROM registered_project_repositories WHERE registered_project_id=?")
            .all(input.registeredProjectId) as Row[]
        ).map((row) => [String(row.repository_id), row]),
      );
      const oldDocuments = new Map(
        (
          db
            .prepare("SELECT * FROM registered_project_documents WHERE registered_project_id=?")
            .all(input.registeredProjectId) as Row[]
        ).map((row) => [String(row.document_id), row]),
      );
      const repositoryIds = new Set(
        input.repositories.map((repository) => repository.repositoryId),
      );
      db.prepare(
        "UPDATE registered_project_repositories SET is_primary=0 WHERE registered_project_id=?",
      ).run(input.registeredProjectId);
      for (const [repositoryId, old] of oldRepositories) {
        if (
          !repositoryIds.has(repositoryId) &&
          (Number(old.active) === 1 || Number(old.is_primary) === 1)
        ) {
          db.prepare(
            "UPDATE registered_project_repositories SET active=0,is_primary=0,record_revision=record_revision+1,updated_at=? WHERE registered_project_id=? AND repository_id=?",
          ).run(now, input.registeredProjectId, repositoryId);
        }
      }
      for (const [ordinal, repository] of input.repositories.entries()) {
        const old = oldRepositories.get(repository.repositoryId);
        const unchanged =
          old?.display_name === repository.displayName &&
          old.server_locator === repository.serverLocator &&
          Number(old.active) === (repository.active ? 1 : 0) &&
          Number(old.is_primary) === (repository.primary ? 1 : 0);
        if (old) {
          db.prepare(
            "UPDATE registered_project_repositories SET display_name=?,server_locator=?,active=?,is_primary=?,ordinal=?,record_revision=?,updated_at=? WHERE registered_project_id=? AND repository_id=?",
          ).run(
            repository.displayName,
            repository.serverLocator,
            repository.active ? 1 : 0,
            repository.primary ? 1 : 0,
            ordinal,
            Number(old.record_revision) + (unchanged ? 0 : 1),
            unchanged ? Number(old.updated_at) : now,
            input.registeredProjectId,
            repository.repositoryId,
          );
        } else {
          db.prepare(
            "INSERT INTO registered_project_repositories(registered_project_id,repository_id,display_name,server_locator,active,is_primary,ordinal,record_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          ).run(
            input.registeredProjectId,
            repository.repositoryId,
            repository.displayName,
            repository.serverLocator,
            repository.active ? 1 : 0,
            repository.primary ? 1 : 0,
            ordinal,
            1,
            now,
            now,
          );
        }
      }
      const documentIds = new Set(input.documents.map((document) => document.documentId));
      for (const [documentId, old] of oldDocuments) {
        if (!documentIds.has(documentId) && Number(old.active) === 1) {
          db.prepare(
            "UPDATE registered_project_documents SET active=0,record_revision=record_revision+1,updated_at=? WHERE registered_project_id=? AND document_id=?",
          ).run(now, input.registeredProjectId, documentId);
        }
      }
      for (const document of input.documents) {
        const old = oldDocuments.get(document.documentId);
        const unchanged =
          old?.repository_id === document.repositoryId &&
          old.kind === document.kind &&
          old.label === document.label &&
          old.server_locator === document.serverLocator &&
          Number(old.active) === 1;
        if (old) {
          db.prepare(
            "UPDATE registered_project_documents SET repository_id=?,kind=?,label=?,server_locator=?,active=1,record_revision=?,updated_at=? WHERE registered_project_id=? AND document_id=?",
          ).run(
            document.repositoryId,
            document.kind,
            document.label,
            document.serverLocator,
            Number(old.record_revision) + (unchanged ? 0 : 1),
            unchanged ? Number(old.updated_at) : now,
            input.registeredProjectId,
            document.documentId,
          );
        } else {
          db.prepare(
            "INSERT INTO registered_project_documents(registered_project_id,document_id,repository_id,kind,label,server_locator,active,record_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          ).run(
            input.registeredProjectId,
            document.documentId,
            document.repositoryId,
            document.kind,
            document.label,
            document.serverLocator,
            1,
            1,
            now,
            now,
          );
        }
      }
      const result = this.#loadRegisteredProject(db, input.registeredProjectId);
      this.#registeredTransition(db, {
        registeredProjectId: input.registeredProjectId,
        action: existing ? "update" : "create",
        actorId: input.actorId,
        hash,
        payload: {
          registeredProjectId: result.registeredProjectId,
          recordRevision: result.recordRevision,
          enabled: result.enabled,
        },
        now,
      });
      this.#saveRegisteredReceipt(
        db,
        input.registeredProjectId,
        "registration",
        input.idempotencyKey,
        hash,
        result,
        now,
      );
      return result;
    }, this.#options);
  }

  listRegisteredProjects(): RegisteredProjectView[] {
    const db = this.#db();
    return (
      db
        .prepare(
          "SELECT registered_project_id FROM registered_projects ORDER BY updated_at DESC,registered_project_id",
        )
        .all() as Row[]
    ).map((row) => this.#loadRegisteredProject(db, String(row.registered_project_id)));
  }

  getRegisteredProject(registeredProjectId: string): RegisteredProjectView {
    requireSafeId(registeredProjectId, "registeredProjectId");
    return this.#loadRegisteredProject(this.#db(), registeredProjectId);
  }

  createRegisteredWorkProject(input: {
    registeredProjectId: string;
    objective: string;
    idempotencyKey: string;
    actorId: string;
  }): {
    registeredProjectId: string;
    projectId: string;
    goalId: string;
    primaryConversationId: string;
    recordRevision: number;
  } {
    requireSafeId(input.registeredProjectId, "registeredProjectId");
    requireText(input.objective, "objective");
    if (input.objective.length > 4_000) {
      throw new WorkPlanValidationError("objective must be bounded text");
    }
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#registeredReceipt(
        db,
        input.registeredProjectId,
        "create_work_project",
        input.idempotencyKey,
        hash,
      );
      if (replay) {
        return replay as ReturnType<ProjectContextRepository["createRegisteredWorkProject"]>;
      }
      const registered = this.#requireEnabledRegistration(db, input.registeredProjectId);
      const projectId = `project-${randomUUID()}`;
      const goalId = `goal-${randomUUID()}`;
      db.prepare(
        "INSERT INTO work_projects(project_id,registered_project_id,primary_conversation_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run(projectId, input.registeredProjectId, registered.defaultConversationId, now, now);
      db.prepare(
        "INSERT INTO work_goals(goal_id,project_id,origin_session_key,session_goal_id,objective,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(goalId, projectId, registered.defaultConversationId, null, input.objective, now, now);
      const result = {
        registeredProjectId: input.registeredProjectId,
        projectId,
        goalId,
        primaryConversationId: registered.defaultConversationId,
        recordRevision: 1,
      };
      this.#transition(db, {
        projectId,
        entityType: "project",
        action: "create_registered",
        actorId: input.actorId,
        hash,
        payload: result,
        now,
      });
      this.#saveRegisteredReceipt(
        db,
        input.registeredProjectId,
        "create_work_project",
        input.idempotencyKey,
        hash,
        result,
        now,
      );
      return result;
    }, this.#options);
  }

  getProjectContext(projectId: string): ProjectContextProjection {
    requireSafeId(projectId, "projectId");
    return this.#loadContext(this.#db(), projectId);
  }

  listDocuments(projectId: string): ProjectDocument[] {
    requireSafeId(projectId, "projectId");
    const db = this.#db();
    this.#requireEnabledProject(db, projectId);
    return (
      db
        .prepare("SELECT * FROM project_documents WHERE project_id=? ORDER BY sequence DESC")
        .all(projectId) as Row[]
    ).map((row) => this.#mapDocument(db, row));
  }

  getDocument(projectId: string, documentId: string, revision?: number): ProjectDocument {
    requireSafeId(projectId, "projectId");
    requireSafeId(documentId, "documentId");
    const db = this.#db();
    this.#requireEnabledProject(db, projectId);
    const row = (
      revision === undefined
        ? db
            .prepare(
              "SELECT * FROM project_documents WHERE project_id=? AND document_id=? ORDER BY sequence DESC LIMIT 1",
            )
            .get(projectId, documentId)
        : db
            .prepare(
              "SELECT * FROM project_documents WHERE project_id=? AND document_id=? AND revision=?",
            )
            .get(projectId, documentId, revision)
    ) as Row | undefined;
    if (!row) {
      throw new WorkPlanNotFoundError(`project document not found: ${documentId}`);
    }
    return this.#mapDocument(db, row);
  }

  updateCapsule(input: {
    projectId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    content: ProjectCapsule;
    provenance: ProjectDocumentProvenance[];
  }): { document: ProjectDocument; projectRecordRevision: number } {
    requireSafeId(input.projectId, "projectId");
    this.#validateCapsule(input.content);
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as { document: ProjectDocument; projectRecordRevision: number };
      }
      this.#requireProjectRevision(db, input.projectId, input.expectedRevision);
      this.#validateProvenance(db, input.projectId, input.provenance);
      const latest = db
        .prepare(
          "SELECT revision FROM project_documents WHERE project_id=? AND kind='capsule' ORDER BY sequence DESC LIMIT 1",
        )
        .get(input.projectId) as Row | undefined;
      const document = this.#insertDocument(db, {
        projectId: input.projectId,
        documentId: "capsule",
        kind: "capsule",
        revision: Number(latest?.revision ?? 0) + 1,
        immutable: false,
        content: input.content,
        provenance: input.provenance,
        now,
      });
      const projectRecordRevision = this.#advanceProjectRevision(
        db,
        input.projectId,
        input.expectedRevision,
        now,
      );
      const result = { document, projectRecordRevision };
      this.#recordDocumentMutation(db, input, document, hash, now);
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  createCheckpoint(input: {
    projectId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
  }): { document: ProjectDocument; projectRecordRevision: number } {
    requireSafeId(input.projectId, "projectId");
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as { document: ProjectDocument; projectRecordRevision: number };
      }
      this.#requireProjectRevision(db, input.projectId, input.expectedRevision);
      const context = this.#loadContext(db, input.projectId);
      if (context.capsuleProvenance?.state === "stale") {
        throw new WorkPlanValidationError("cannot checkpoint a capsule with stale provenance");
      }
      const progress = context.plans.map((plan) => `${plan.display}: ${plan.status}`);
      const content: ProjectCheckpoint = {
        objective: context.goal.objective,
        progress,
        files: [],
        tests: [],
        blockers: context.capsule?.content.conflicts ?? [],
        exactNextAction: context.capsule?.content.explicitNextTask ?? context.goal.objective,
        plans: context.plans,
      };
      const provenance: ProjectDocumentProvenance[] = [
        ...context.plans.map((plan) => ({
          sourceType: "work_plan" as const,
          sourceId: plan.planId,
          sourceRevision: plan.recordRevision,
        })),
        ...(context.capsule
          ? [
              {
                sourceType: "project_document" as const,
                sourceId: context.capsule.documentId,
                sourceRevision: context.capsule.revision,
              },
            ]
          : []),
      ];
      const document = this.#insertDocument(db, {
        projectId: input.projectId,
        documentId: `checkpoint-${randomUUID()}`,
        kind: "checkpoint",
        revision: 1,
        immutable: true,
        content,
        provenance,
        now,
      });
      const projectRecordRevision = this.#advanceProjectRevision(
        db,
        input.projectId,
        input.expectedRevision,
        now,
      );
      const result = { document, projectRecordRevision };
      this.#recordDocumentMutation(db, input, document, hash, now);
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  createHandoff(input: {
    projectId: string;
    checkpointDocumentId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
  }): { document: ProjectDocument; projectRecordRevision: number } {
    requireSafeId(input.projectId, "projectId");
    requireSafeId(input.checkpointDocumentId, "checkpointDocumentId");
    const hash = requestHash(input);
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#receipt(db, input.projectId, input.idempotencyKey, hash);
      if (replay) {
        return replay as { document: ProjectDocument; projectRecordRevision: number };
      }
      this.#requireProjectRevision(db, input.projectId, input.expectedRevision);
      const checkpointRow = db
        .prepare(
          "SELECT * FROM project_documents WHERE project_id=? AND document_id=? AND kind='checkpoint' AND immutable=1 ORDER BY sequence DESC LIMIT 1",
        )
        .get(input.projectId, input.checkpointDocumentId) as Row | undefined;
      if (!checkpointRow) {
        throw new WorkPlanValidationError("checkpoint must be an immutable same-project document");
      }
      const checkpoint = this.#mapDocument(db, checkpointRow);
      if (checkpoint.kind !== "checkpoint") {
        throw new WorkPlanValidationError("handoff source must be a checkpoint");
      }
      const content: ProjectHandoff = {
        checkpointDocumentId: checkpoint.documentId,
        objective: checkpoint.content.objective,
        progress: checkpoint.content.progress,
        blockers: checkpoint.content.blockers,
        exactNextAction: checkpoint.content.exactNextAction,
      };
      const document = this.#insertDocument(db, {
        projectId: input.projectId,
        documentId: `handoff-${randomUUID()}`,
        kind: "handoff",
        revision: 1,
        immutable: true,
        content,
        provenance: [
          {
            sourceType: "project_document",
            sourceId: checkpoint.documentId,
            sourceRevision: checkpoint.revision,
          },
        ],
        now,
      });
      const projectRecordRevision = this.#advanceProjectRevision(
        db,
        input.projectId,
        input.expectedRevision,
        now,
      );
      const result = { document, projectRecordRevision };
      this.#recordDocumentMutation(db, input, document, hash, now);
      this.#saveReceipt(db, input.projectId, input.idempotencyKey, hash, result, now);
      return result;
    }, this.#options);
  }

  #loadRegisteredProject(db: DatabaseSync, registeredProjectId: string): RegisteredProjectView {
    const project = db
      .prepare("SELECT * FROM registered_projects WHERE registered_project_id=?")
      .get(registeredProjectId) as Row | undefined;
    if (!project) {
      throw new WorkPlanNotFoundError(`registered project not found: ${registeredProjectId}`);
    }
    const repositoryRows = db
      .prepare(
        "SELECT repository_id,display_name,active,is_primary,record_revision FROM registered_project_repositories WHERE registered_project_id=? ORDER BY ordinal,repository_id",
      )
      .all(registeredProjectId) as Row[];
    const primaryRepositories = repositoryRows.filter(
      (repository) => Number(repository.is_primary) === 1,
    );
    if (primaryRepositories.length !== 1 || Number(primaryRepositories[0]?.active) !== 1) {
      throw new WorkPlanValidationError(
        "registered project does not have exactly one primary repository",
      );
    }
    const documents = db
      .prepare(
        "SELECT document_id,repository_id,kind,label,record_revision,updated_at FROM registered_project_documents WHERE registered_project_id=? AND active=1 ORDER BY document_id",
      )
      .all(registeredProjectId) as Row[];
    const activeRepositoryIds = new Set(
      repositoryRows
        .filter((repository) => Number(repository.active) === 1)
        .map((repository) => String(repository.repository_id)),
    );
    if (documents.some((document) => !activeRepositoryIds.has(String(document.repository_id)))) {
      throw new WorkPlanValidationError(
        "active registered document belongs to an inactive repository",
      );
    }
    if (project.profile !== PROJECT_PROFILE) {
      throw new WorkPlanValidationError(`unsupported project profile: ${String(project.profile)}`);
    }
    return {
      registeredProjectId,
      displayName: String(project.display_name),
      enabled: Number(project.enabled) === 1,
      profile: PROJECT_PROFILE,
      defaultConversationId: String(project.default_conversation_id),
      recordRevision: Number(project.record_revision),
      updatedAt: Number(project.updated_at),
      repositories: repositoryRows
        .filter((repository) => Number(repository.active) === 1)
        .map((repository) => ({
          repositoryId: String(repository.repository_id),
          displayName: String(repository.display_name),
          active: Number(repository.active) === 1,
          primary: Number(repository.is_primary) === 1,
          recordRevision: Number(repository.record_revision),
        })),
      documents: documents.map((document) => ({
        documentId: String(document.document_id),
        repositoryId: String(document.repository_id),
        kind: String(document.kind) as RegisteredDocumentKind,
        label: String(document.label),
        recordRevision: Number(document.record_revision),
        updatedAt: Number(document.updated_at),
      })),
    };
  }

  #requireEnabledRegistration(
    db: DatabaseSync,
    registeredProjectId: string,
  ): RegisteredProjectView {
    const project = this.#loadRegisteredProject(db, registeredProjectId);
    if (!project.enabled) {
      throw new WorkPlanValidationError(`registered project is disabled: ${registeredProjectId}`);
    }
    return project;
  }

  #requireEnabledProject(db: DatabaseSync, projectId: string): Row {
    const project = db.prepare("SELECT * FROM work_projects WHERE project_id=?").get(projectId) as
      | Row
      | undefined;
    if (!project) {
      throw new WorkPlanNotFoundError(`project not found: ${projectId}`);
    }
    if (!project.registered_project_id) {
      throw new WorkPlanValidationError("project is not linked to a registered project");
    }
    this.#requireEnabledRegistration(db, String(project.registered_project_id));
    return project;
  }

  #requireProjectRevision(db: DatabaseSync, projectId: string, expectedRevision: number): Row {
    const project = this.#requireEnabledProject(db, projectId);
    if (Number(project.record_revision) !== expectedRevision) {
      throw new WorkPlanConflictError("stale project revision");
    }
    return project;
  }

  #loadContext(db: DatabaseSync, projectId: string): ProjectContextProjection {
    const project = this.#requireEnabledProject(db, projectId);
    const registeredProject = this.#loadRegisteredProject(
      db,
      String(project.registered_project_id),
    );
    const goal = db.prepare("SELECT * FROM work_goals WHERE project_id=?").get(projectId) as
      | Row
      | undefined;
    if (!goal) {
      throw new WorkPlanNotFoundError(`goal not found for project: ${projectId}`);
    }
    const plans = (
      db
        .prepare(
          "SELECT plan_id,status,display_cursor,record_revision,definition_revision FROM work_plans WHERE project_id=? ORDER BY updated_at DESC,plan_id LIMIT 50",
        )
        .all(projectId) as Row[]
    ).map((plan) => {
      const total = db
        .prepare(
          "SELECT COUNT(*) AS count FROM work_plan_steps WHERE plan_id=? AND definition_revision=?",
        )
        .get(plan.plan_id, plan.definition_revision) as Row;
      return {
        planId: String(plan.plan_id),
        status: String(plan.status) as WorkPlanStatus,
        display: `Plan ${Number(plan.display_cursor)}/${Number(total.count)}`,
        recordRevision: Number(plan.record_revision),
      };
    });
    const latest = (kind: "capsule" | "checkpoint" | "handoff"): ProjectDocument | undefined => {
      const row = db
        .prepare(
          "SELECT * FROM project_documents WHERE project_id=? AND kind=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(projectId, kind) as Row | undefined;
      return row ? this.#mapDocument(db, row) : undefined;
    };
    const capsule = latest("capsule") as Extract<ProjectDocument, { kind: "capsule" }> | undefined;
    const latestCheckpoint = latest("checkpoint") as
      | Extract<ProjectDocument, { kind: "checkpoint" }>
      | undefined;
    const latestHandoff = latest("handoff") as
      | Extract<ProjectDocument, { kind: "handoff" }>
      | undefined;
    const staleRefs = capsule
      ? this.#staleProvenance(db, projectId, capsule.provenance)
      : undefined;
    return {
      project: {
        projectId,
        primaryConversationId: String(project.primary_conversation_id),
        recordRevision: Number(project.record_revision),
        updatedAt: Number(project.updated_at),
      },
      registeredProject,
      goal: {
        goalId: String(goal.goal_id),
        objective: String(goal.objective),
        ...(goal.session_goal_id ? { sessionGoalRef: String(goal.session_goal_id) } : {}),
        recordRevision: Number(goal.record_revision),
      },
      plans,
      ...(capsule ? { capsule } : {}),
      ...(staleRefs
        ? {
            capsuleProvenance: {
              state: staleRefs.length === 0 ? ("current" as const) : ("stale" as const),
              staleRefs,
            },
          }
        : {}),
      ...(latestCheckpoint ? { latestCheckpoint } : {}),
      ...(latestHandoff ? { latestHandoff } : {}),
    };
  }

  #validateCapsule(content: ProjectCapsule): void {
    const fields = [content.summary, content.currentFocus, content.explicitNextTask];
    if (fields.some((field) => !field.trim() || field.length > 4_000)) {
      throw new WorkPlanValidationError(
        "capsule summary, focus, and next task must be bounded text",
      );
    }
    for (const entries of [
      content.constraints,
      content.decisions,
      content.openQuestions,
      content.conflicts,
    ]) {
      if (entries.length > 50 || entries.some((entry) => !entry.trim() || entry.length > 2_000)) {
        throw new WorkPlanValidationError("capsule lists must contain bounded non-empty text");
      }
    }
  }

  #validateProvenance(
    db: DatabaseSync,
    projectId: string,
    provenance: ProjectDocumentProvenance[],
  ): void {
    if (provenance.length > 50) {
      throw new WorkPlanValidationError("too many provenance references");
    }
    for (const source of provenance) {
      requireSafeId(source.sourceId, "provenance sourceId");
      if (source.sourceRevision < 1) {
        throw new WorkPlanValidationError("provenance sourceRevision must be positive");
      }
    }
    if (this.#staleProvenance(db, projectId, provenance).length > 0) {
      throw new WorkPlanValidationError("provenance source is stale, foreign, or unknown");
    }
  }

  #staleProvenance(
    db: DatabaseSync,
    projectId: string,
    provenance: ProjectDocumentProvenance[],
  ): ProjectDocumentProvenance[] {
    return provenance.filter((source) => {
      if (source.sourceType === "work_plan") {
        const row = db
          .prepare("SELECT record_revision FROM work_plans WHERE project_id=? AND plan_id=?")
          .get(projectId, source.sourceId) as Row | undefined;
        return !row || Number(row.record_revision) !== source.sourceRevision;
      }
      if (source.sourceType === "registered_document") {
        const row = db
          .prepare(
            "SELECT d.record_revision,d.active FROM registered_project_documents d JOIN work_projects p ON p.registered_project_id=d.registered_project_id WHERE p.project_id=? AND d.document_id=?",
          )
          .get(projectId, source.sourceId) as Row | undefined;
        return (
          !row || Number(row.active) !== 1 || Number(row.record_revision) !== source.sourceRevision
        );
      }
      const row = db
        .prepare(
          "SELECT 1 AS ok FROM project_documents WHERE project_id=? AND document_id=? AND revision=?",
        )
        .get(projectId, source.sourceId, source.sourceRevision) as Row | undefined;
      return !row;
    });
  }

  #insertDocument(
    db: DatabaseSync,
    input: {
      projectId: string;
      documentId: string;
      kind: "capsule" | "checkpoint" | "handoff";
      revision: number;
      immutable: boolean;
      content: ProjectCapsule | ProjectCheckpoint | ProjectHandoff;
      provenance: ProjectDocumentProvenance[];
      now: number;
    },
  ): ProjectDocument {
    const inserted = db
      .prepare(
        "INSERT INTO project_documents(project_id,document_id,kind,revision,immutable,content_json,created_at) VALUES(?,?,?,?,?,?,?) RETURNING sequence",
      )
      .get(
        input.projectId,
        input.documentId,
        input.kind,
        input.revision,
        input.immutable ? 1 : 0,
        JSON.stringify(input.content),
        input.now,
      ) as Row;
    const insertProvenance = db.prepare(
      "INSERT INTO project_document_provenance(document_sequence,ordinal,source_type,source_id,source_revision) VALUES(?,?,?,?,?)",
    );
    for (const [ordinal, source] of input.provenance.entries()) {
      insertProvenance.run(
        inserted.sequence,
        ordinal,
        source.sourceType,
        source.sourceId,
        source.sourceRevision,
      );
    }
    const row = db
      .prepare("SELECT * FROM project_documents WHERE sequence=?")
      .get(inserted.sequence) as Row;
    return this.#mapDocument(db, row);
  }

  #mapDocument(db: DatabaseSync, row: Row): ProjectDocument {
    const provenance = (
      db
        .prepare(
          "SELECT source_type,source_id,source_revision FROM project_document_provenance WHERE document_sequence=? ORDER BY ordinal",
        )
        .all(row.sequence) as Row[]
    ).map((source) => ({
      sourceType: String(source.source_type) as ProjectDocumentProvenance["sourceType"],
      sourceId: String(source.source_id),
      sourceRevision: Number(source.source_revision),
    }));
    const common = {
      documentId: String(row.document_id),
      revision: Number(row.revision),
      provenance,
      createdAt: Number(row.created_at),
    };
    if (row.kind === "capsule") {
      return {
        ...common,
        kind: "capsule",
        immutable: false,
        content: JSON.parse(String(row.content_json)) as ProjectCapsule,
      };
    }
    if (row.kind === "checkpoint") {
      return {
        ...common,
        kind: "checkpoint",
        revision: 1,
        immutable: true,
        content: JSON.parse(String(row.content_json)) as ProjectCheckpoint,
      };
    }
    return {
      ...common,
      kind: "handoff",
      revision: 1,
      immutable: true,
      content: JSON.parse(String(row.content_json)) as ProjectHandoff,
    };
  }

  #advanceProjectRevision(
    db: DatabaseSync,
    projectId: string,
    expectedRevision: number,
    now: number,
  ): number {
    const updated = db
      .prepare(
        "UPDATE work_projects SET record_revision=record_revision+1,updated_at=? WHERE project_id=? AND record_revision=?",
      )
      .run(now, projectId, expectedRevision);
    if (updated.changes !== 1) {
      throw new WorkPlanConflictError("stale project revision");
    }
    return expectedRevision + 1;
  }

  #recordDocumentMutation(
    db: DatabaseSync,
    input: { projectId: string; actorId: string },
    document: ProjectDocument,
    hash: string,
    now: number,
  ): void {
    this.#transition(db, {
      projectId: input.projectId,
      entityType: "project_document",
      action: document.kind === "capsule" ? "update_capsule" : `create_${document.kind}`,
      actorId: input.actorId,
      hash,
      payload: {
        documentId: document.documentId,
        kind: document.kind,
        revision: document.revision,
        provenance: document.provenance,
      },
      now,
    });
  }

  #receipt(db: DatabaseSync, projectId: string, key: string, hash: string): unknown {
    const row = db
      .prepare(
        "SELECT request_hash,result_json FROM work_plan_mutation_receipts WHERE project_id=? AND idempotency_key=?",
      )
      .get(projectId, key) as Row | undefined;
    if (!row) {
      return undefined;
    }
    if (row.request_hash !== hash) {
      throw new WorkPlanConflictError("idempotency key reused with a different request");
    }
    return JSON.parse(String(row.result_json));
  }

  #saveReceipt(
    db: DatabaseSync,
    projectId: string,
    key: string,
    hash: string,
    result: unknown,
    now: number,
  ): void {
    db.prepare(
      "INSERT INTO work_plan_mutation_receipts(project_id,idempotency_key,request_hash,result_json,created_at) VALUES(?,?,?,?,?)",
    ).run(projectId, key, hash, JSON.stringify(result), now);
  }

  #registeredReceipt(
    db: DatabaseSync,
    registeredProjectId: string,
    operationScope: "registration" | "create_work_project",
    key: string,
    hash: string,
  ): unknown {
    const row = db
      .prepare(
        "SELECT request_hash,result_json FROM registered_project_mutation_receipts WHERE registered_project_id=? AND operation_scope=? AND idempotency_key=?",
      )
      .get(registeredProjectId, operationScope, key) as Row | undefined;
    if (!row) {
      return undefined;
    }
    if (row.request_hash !== hash) {
      throw new WorkPlanConflictError("idempotency key reused with a different request");
    }
    return JSON.parse(String(row.result_json));
  }

  #saveRegisteredReceipt(
    db: DatabaseSync,
    registeredProjectId: string,
    operationScope: "registration" | "create_work_project",
    key: string,
    hash: string,
    result: unknown,
    now: number,
  ): void {
    db.prepare(
      "INSERT INTO registered_project_mutation_receipts(registered_project_id,operation_scope,idempotency_key,request_hash,result_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(registeredProjectId, operationScope, key, hash, JSON.stringify(result), now);
  }

  #registeredTransition(
    db: DatabaseSync,
    input: {
      registeredProjectId: string;
      action: string;
      actorId: string;
      hash: string;
      payload: unknown;
      now: number;
    },
  ): void {
    db.prepare(
      "INSERT INTO registered_project_transitions(transition_id,registered_project_id,action,actor_id,request_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      input.registeredProjectId,
      input.action,
      input.actorId,
      input.hash,
      JSON.stringify(input.payload),
      input.now,
    );
  }

  #transition(
    db: DatabaseSync,
    input: {
      projectId: string;
      entityType: string;
      action: string;
      actorId: string;
      hash: string;
      payload: unknown;
      now: number;
    },
  ): void {
    db.prepare(
      "INSERT INTO work_plan_transitions(transition_id,project_id,entity_type,action,actor_id,request_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      input.projectId,
      input.entityType,
      input.action,
      input.actorId,
      input.hash,
      JSON.stringify(input.payload),
      input.now,
    );
  }
}
