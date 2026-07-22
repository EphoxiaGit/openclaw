import type { WorkPlanStatus } from "./types.js";

export const PROJECT_PROFILE = "repo-planning-v1" as const;
export type RegisteredDocumentKind =
  | "current"
  | "architecture"
  | "constraints"
  | "decisions"
  | "tasks"
  | "handoff"
  | "other";

export type TrustedRegisteredProjectInput = {
  registeredProjectId: string;
  displayName: string;
  enabled: boolean;
  profile: string;
  defaultConversationId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorId: string;
  repositories: Array<{
    repositoryId: string;
    displayName: string;
    serverLocator: string;
    active: boolean;
    primary: boolean;
  }>;
  documents: Array<{
    documentId: string;
    repositoryId: string;
    kind: RegisteredDocumentKind;
    label: string;
    serverLocator: string;
  }>;
};

export type RegisteredProjectView = {
  registeredProjectId: string;
  displayName: string;
  enabled: boolean;
  profile: typeof PROJECT_PROFILE;
  defaultConversationId: string;
  recordRevision: number;
  updatedAt: number;
  repositories: Array<{
    repositoryId: string;
    displayName: string;
    active: boolean;
    primary: boolean;
    recordRevision: number;
  }>;
  documents: Array<{
    documentId: string;
    repositoryId: string;
    kind: RegisteredDocumentKind;
    label: string;
    recordRevision: number;
    updatedAt: number;
  }>;
};

export type ProjectDocumentProvenance = {
  sourceType: "work_plan" | "registered_document" | "project_document";
  sourceId: string;
  sourceRevision: number;
};

export type ProjectCapsule = {
  summary: string;
  currentFocus: string;
  constraints: string[];
  decisions: string[];
  openQuestions: string[];
  conflicts: string[];
  explicitNextTask: string;
};

export type ProjectCheckpoint = {
  objective: string;
  progress: string[];
  files: string[];
  tests: string[];
  blockers: string[];
  exactNextAction: string;
  plans: Array<{
    planId: string;
    status: WorkPlanStatus;
    display: string;
    recordRevision: number;
  }>;
};

export type ProjectHandoff = {
  checkpointDocumentId: string;
  objective: string;
  progress: string[];
  blockers: string[];
  exactNextAction: string;
};

export type ProjectDocument =
  | {
      documentId: string;
      kind: "capsule";
      revision: number;
      immutable: false;
      content: ProjectCapsule;
      provenance: ProjectDocumentProvenance[];
      createdAt: number;
    }
  | {
      documentId: string;
      kind: "checkpoint";
      revision: 1;
      immutable: true;
      content: ProjectCheckpoint;
      provenance: ProjectDocumentProvenance[];
      createdAt: number;
    }
  | {
      documentId: string;
      kind: "handoff";
      revision: 1;
      immutable: true;
      content: ProjectHandoff;
      provenance: ProjectDocumentProvenance[];
      createdAt: number;
    };

export type ProjectContextProjection = {
  project: {
    projectId: string;
    primaryConversationId: string;
    recordRevision: number;
    updatedAt: number;
  };
  registeredProject: RegisteredProjectView;
  goal: { goalId: string; objective: string; sessionGoalRef?: string; recordRevision: number };
  plans: ProjectCheckpoint["plans"];
  capsule?: Extract<ProjectDocument, { kind: "capsule" }>;
  capsuleProvenance?: {
    state: "current" | "stale";
    staleRefs: ProjectDocumentProvenance[];
  };
  latestCheckpoint?: Extract<ProjectDocument, { kind: "checkpoint" }>;
  latestHandoff?: Extract<ProjectDocument, { kind: "handoff" }>;
};
