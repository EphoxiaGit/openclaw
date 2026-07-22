import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWorkCapsulesUpdateParams,
  validateWorkCheckpointsCreateParams,
  validateWorkDocumentsGetParams,
  validateWorkDocumentsListParams,
  validateWorkHandoffsCreateParams,
  validateWorkPlansCreateParams,
  validateWorkPlansGetParams,
  validateWorkPlansHistoryParams,
  validateWorkPlansMutateParams,
  validateWorkPlansProjectionParams,
  validateWorkProjectsCreateParams,
  validateWorkProjectsCreateRegisteredParams,
  validateWorkProjectsGetParams,
  validateWorkProjectsListParams,
  validateWorkProjectContextGetParams,
  validateWorkRegisteredProjectsGetParams,
  validateWorkRegisteredProjectsListParams,
  validateWorkWorkersCancelParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { hasConfiguredModelFallbacks } from "../../agents/agent-scope.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeInspection } from "../../agents/worktrees/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import { hasSessionActiveAutoModelFallback } from "../../config/sessions/model-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactToolDetail } from "../../logging/redact.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import { listTaskRecords } from "../../tasks/runtime-internal.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import { listTaskFlowRecords } from "../../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { ProjectContextRepository } from "../../work-plans/project-context-repository.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import {
  WorkPlanConflictError,
  WorkPlanNotFoundError,
  WorkPlanValidationError,
  type WorkPlanSnapshot,
} from "../../work-plans/types.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionThinkingProjection,
  resolveSessionModelRef,
} from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import type { GatewayClient } from "./types.js";

type WorkerState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost"
  | "unknown";
type WorkerSessionFacts = {
  provider?: string;
  model?: string;
  runtime?: string;
  requestedProvider?: string;
  requestedModel?: string;
  actualProvider?: string;
  actualModel?: string;
  routeSource?: "task_override" | "agent_policy" | "automatic_fallback" | "unknown";
  exactModel?: "matched" | "substituted" | "unverified" | "not_requested";
  fallback?: "disabled" | "configured" | "used" | "unknown";
  fallbackReason?: string;
  pacing?: "standard" | "fast" | "auto" | "unknown";
  pacingSource?: "session" | "agent" | "config" | "default" | "unknown";
  quotaLane?: string;
  contextPercent?: number;
};

const TECHNICAL_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function technicalText(value: unknown): string | undefined {
  return typeof value === "string" && TECHNICAL_TEXT.test(value) ? value : undefined;
}

function boundedNarrative(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const redacted = redactToolDetail(value.trim()).slice(0, 1_000).trim();
  return redacted || undefined;
}

function relativeFilePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 500) {
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function workerState(value: string | undefined): WorkerState {
  switch (value) {
    case "queued":
    case "running":
    case "waiting":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "timed_out":
    case "lost":
      return value;
    case "completed":
      return "succeeded";
    default:
      return "unknown";
  }
}

function workerHealth(state: WorkerState) {
  switch (state) {
    case "queued":
    case "succeeded":
      return "available" as const;
    case "running":
      return "busy" as const;
    case "failed":
    case "cancelled":
    case "timed_out":
    case "lost":
      return "unavailable" as const;
    default:
      return "unknown" as const;
  }
}

function taskIdentifiers(task: TaskRecord): string[] {
  return [task.taskId, task.runId, task.parentFlowId, task.sourceId].filter(
    (value): value is string => Boolean(value),
  );
}

function matchWorkPlanAttempts(plan: WorkPlanSnapshot, tasks: readonly TaskRecord[]) {
  const taskByIdentifier = new Map<string, TaskRecord>();
  for (const task of tasks) {
    for (const identifier of taskIdentifiers(task)) {
      taskByIdentifier.set(identifier, task);
    }
  }
  return plan.steps.flatMap((step) =>
    step.attempts.map((attempt) => ({
      attempt,
      step,
      task: taskByIdentifier.get(attempt.ownerId),
    })),
  );
}

function currentWorkPlan(project: ReturnType<WorkPlanRepository["getProject"]>) {
  const active = project.plans.filter(
    (plan) => !["completed", "failed", "cancelled", "superseded"].includes(plan.status),
  );
  if (active.length > 1) {
    return undefined;
  }
  return active[0] ?? project.plans[0];
}

function resolveWorkPlanWorkerTask(params: {
  plan: WorkPlanSnapshot;
  tasks: readonly TaskRecord[];
  workerKey: string;
}): TaskRecord | undefined {
  return matchWorkPlanAttempts(params.plan, params.tasks).find(
    ({ attempt, step }) => `worker-${step.ordinal}-${attempt.attemptNumber}` === params.workerKey,
  )?.task;
}

function workerOwnerKind(ownerType: string, task: TaskRecord | undefined) {
  if (ownerType === "omx" || ownerType === "task_flow" || task?.runtime === "cron") {
    return "durable_job" as const;
  }
  if (task?.childSessionKey || task?.runtime === "subagent" || task?.runtime === "acp") {
    return "isolated" as const;
  }
  if (ownerType === "task" || ownerType === "codex") {
    return "inline" as const;
  }
  return "unknown" as const;
}

function workerElapsedMs(params: {
  task?: TaskRecord;
  attempt: WorkPlanSnapshot["steps"][number]["attempts"][number];
  now: number;
}): number | undefined {
  const startedAt = params.task?.startedAt ?? params.task?.createdAt ?? params.attempt.createdAt;
  const endedAt = params.task?.endedAt ?? params.attempt.endedAt;
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return Math.max(0, (endedAt ?? params.now) - startedAt);
}

export function projectWorkPlanWorkers(params: {
  plan: WorkPlanSnapshot;
  tasks: readonly TaskRecord[];
  now?: number;
  resolveSessionFacts?: (task: TaskRecord) => WorkerSessionFacts;
}) {
  const matches = matchWorkPlanAttempts(params.plan, params.tasks);
  const keyByTaskId = new Map(
    matches.flatMap(({ attempt, step, task }) =>
      task ? [[task.taskId, `worker-${step.ordinal}-${attempt.attemptNumber}`] as const] : [],
    ),
  );
  const now = params.now ?? Date.now();
  return matches.slice(0, 100).map(({ attempt, step, task }) => {
    const key = `worker-${step.ordinal}-${attempt.attemptNumber}`;
    const state = workerState(task?.status ?? attempt.ownerState);
    const session = task && params.resolveSessionFacts ? params.resolveSessionFacts(task) : {};
    const role = technicalText(task?.agentId) ?? technicalText(attempt.ownerType) ?? "unknown";
    const lane = technicalText(task?.runtime) ?? technicalText(attempt.ownerType) ?? "unknown";
    const progress = boundedNarrative(task?.progressSummary);
    const result = boundedNarrative(task?.terminalSummary);
    const elapsedMs = workerElapsedMs({ task, attempt, now });
    const parentKey = task?.parentTaskId ? keyByTaskId.get(task.parentTaskId) : undefined;
    return Object.assign(
      {
        key,
        label: boundedNarrative(task?.label) ?? boundedNarrative(step.title) ?? "Worker",
        ownerKind: workerOwnerKind(attempt.ownerType, task),
        role,
        lane,
        state,
        health: workerHealth(state),
        canCancel: task?.status === "queued" || task?.status === "running",
        canRetry: false,
        routeSource: session.routeSource ?? "unknown",
        exactModel: session.exactModel ?? "unverified",
        fallback: session.fallback ?? "unknown",
        pacing: session.pacing ?? "unknown",
        pacingSource: session.pacingSource ?? "unknown",
      },
      parentKey ? { parentKey } : {},
      session.provider ? { provider: session.provider } : {},
      session.model ? { model: session.model } : {},
      session.runtime ? { runtime: session.runtime } : {},
      session.requestedProvider ? { requestedProvider: session.requestedProvider } : {},
      session.requestedModel ? { requestedModel: session.requestedModel } : {},
      session.actualProvider ? { actualProvider: session.actualProvider } : {},
      session.actualModel ? { actualModel: session.actualModel } : {},
      session.fallbackReason ? { fallbackReason: session.fallbackReason } : {},
      session.quotaLane ? { quotaLane: session.quotaLane } : {},
      progress ? { progress } : {},
      result ? { result } : {},
      session.contextPercent !== undefined ? { contextPercent: session.contextPercent } : {},
      elapsedMs !== undefined ? { elapsedMs } : {},
    );
  });
}

type OrchestrationPattern = "planner_reviewer" | "diagnostic_handoff" | "sequential" | "custom";

function orchestrationPattern(flow: TaskFlowRecord | undefined): OrchestrationPattern {
  const state = flow?.stateJson;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return "custom";
  }
  const pattern = state.pattern;
  return pattern === "planner_reviewer" ||
    pattern === "diagnostic_handoff" ||
    pattern === "sequential" ||
    pattern === "custom"
    ? pattern
    : "custom";
}

function orchestrationWait(flow: TaskFlowRecord | undefined) {
  const wait = flow?.waitJson;
  if (!wait || typeof wait !== "object" || Array.isArray(wait)) {
    return { kind: "none" as const, resumable: false };
  }
  const kind = wait.kind;
  if (kind === "lobster_approval") {
    return {
      kind: "approval" as const,
      resumable: typeof wait.resumeToken === "string" || typeof wait.approvalId === "string",
    };
  }
  if (kind === "input_request") {
    return {
      kind: "input" as const,
      resumable: false,
      ...(typeof wait.requestId === "string" ? { inputRequestId: wait.requestId } : {}),
    };
  }
  return { kind: "other" as const, resumable: false };
}

function orchestrationDelivery(tasks: readonly TaskRecord[]) {
  if (tasks.length === 0 || tasks.every((task) => task.deliveryStatus === "not_applicable")) {
    return "not_applicable" as const;
  }
  if (
    tasks.some(
      (task) => task.deliveryStatus === "failed" || task.deliveryStatus === "parent_missing",
    )
  ) {
    return "failed" as const;
  }
  if (
    tasks.some(
      (task) => task.deliveryStatus === "pending" || task.deliveryStatus === "session_queued",
    )
  ) {
    return "pending" as const;
  }
  return tasks.some((task) => task.deliveryStatus === "delivered")
    ? ("delivered" as const)
    : ("unknown" as const);
}

export function projectWorkPlanOrchestration(params: {
  plan: WorkPlanSnapshot;
  flows: readonly TaskFlowRecord[];
  tasks: readonly TaskRecord[];
}) {
  const flowById = new Map(params.flows.map((flow) => [flow.flowId, flow]));
  return params.plan.steps
    .flatMap((step) =>
      step.attempts
        .filter((attempt) => attempt.ownerType === "task_flow")
        .map((attempt) => ({ attempt, step, flow: flowById.get(attempt.ownerId) })),
    )
    .slice(0, 100)
    .map(({ attempt, step, flow }) => {
      const tasks = flow ? params.tasks.filter((task) => task.parentFlowId === flow.flowId) : [];
      const wait = orchestrationWait(flow);
      const state = flow?.status ?? "unknown";
      const active =
        state === "queued" || state === "running" || state === "waiting" || state === "blocked";
      const phase = boundedNarrative(flow?.currentStep);
      const goal = boundedNarrative(flow?.goal);
      const result = tasks
        .toSorted((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))
        .map((task) => boundedNarrative(task.terminalSummary))
        .find((summary): summary is string => Boolean(summary));
      return {
        key: `orchestration-${step.ordinal}-${attempt.attemptNumber}`,
        label: boundedNarrative(step.title) ?? "Durable job",
        ...(goal ? { goal } : {}),
        pattern: orchestrationPattern(flow),
        ...(phase ? { phase } : {}),
        state,
        waitKind: wait.kind,
        ...(wait.inputRequestId ? { inputRequestId: wait.inputRequestId } : {}),
        attemptNumber: attempt.attemptNumber,
        taskCount: tasks.length,
        activeTaskCount: tasks.filter(
          (task) => task.status === "queued" || task.status === "running",
        ).length,
        failureCount: tasks.filter(
          (task) =>
            task.status === "failed" || task.status === "timed_out" || task.status === "lost",
        ).length,
        completionDelivery: orchestrationDelivery(tasks),
        notifyPolicy: flow?.notifyPolicy ?? "unknown",
        ...(result ? { result } : {}),
        canResume: (state === "waiting" || state === "blocked") && wait.resumable,
        canCancel: active && flow?.cancelRequestedAt == null,
      };
    });
}

function worktreeCommitState(inspection: ManagedWorktreeInspection) {
  if (inspection.state === "restorable") {
    return "restorable" as const;
  }
  if (inspection.conflictCount > 0) {
    return "conflicted" as const;
  }
  if (inspection.changeCount > 0) {
    return "uncommitted" as const;
  }
  if (inspection.unpushedCommitCount > 0) {
    return "unpushed" as const;
  }
  return "clean" as const;
}

export async function projectWorkPlanWorktrees(params: {
  plan: WorkPlanSnapshot;
  inspect: (id: string) => Promise<ManagedWorktreeInspection>;
}) {
  const links = params.plan.steps
    .flatMap((step) => step.worktreeLinks.map((worktreeId, index) => ({ step, worktreeId, index })))
    .slice(0, 100);
  return await Promise.all(
    links.map(async ({ step, worktreeId, index }) => {
      const key = `worktree-${step.ordinal}-${index + 1}`;
      const stepTitle = boundedNarrative(step.title) ?? "Worktree";
      try {
        const inspection = await params.inspect(worktreeId);
        const label = technicalText(inspection.record.name) ?? "Managed worktree";
        const branch = technicalText(inspection.record.branch);
        const baseRef = technicalText(inspection.record.baseRef);
        const diffStat = boundedNarrative(inspection.diffStat);
        return {
          key,
          label,
          stepTitle,
          ...(branch ? { branch } : {}),
          ...(baseRef ? { baseRef } : {}),
          state: inspection.state,
          commitState: worktreeCommitState(inspection),
          changeCount: inspection.changeCount,
          stagedCount: inspection.stagedCount,
          unstagedCount: inspection.unstagedCount,
          untrackedCount: inspection.untrackedCount,
          conflictCount: inspection.conflictCount,
          unpushedCommitCount: inspection.unpushedCommitCount,
          files: inspection.files.flatMap((file) => relativeFilePath(file) ?? []).slice(0, 200),
          ...(diffStat ? { diffStat } : {}),
          filesTruncated: inspection.filesTruncated,
          diffStatTruncated: inspection.diffStatTruncated,
          canTest: inspection.state === "active",
          canPrepareCommit:
            inspection.state === "active" &&
            inspection.changeCount > 0 &&
            inspection.conflictCount === 0,
          canResolveConflicts: inspection.state === "active" && inspection.conflictCount > 0,
          canResume: inspection.state === "restorable",
          canRollback: inspection.state === "active" && inspection.changeCount > 0,
        };
      } catch {
        return {
          key,
          label: "Managed worktree",
          stepTitle,
          state: "unavailable" as const,
          commitState: "unavailable" as const,
          changeCount: 0,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          conflictCount: 0,
          unpushedCommitCount: 0,
          files: [],
          filesTruncated: false,
          diffStatTruncated: false,
          canTest: false,
          canPrepareCommit: false,
          canResolveConflicts: false,
          canResume: false,
          canRollback: false,
        };
      }
    }),
  );
}

function resolveWorkerSessionFacts(
  cfg: OpenClawConfig,
  store: Record<string, SessionEntry>,
  task: TaskRecord,
): WorkerSessionFacts {
  const sessionKey = task.childSessionKey;
  const entry = sessionKey ? store[sessionKey] : undefined;
  if (!sessionKey || !entry) {
    return {};
  }
  const agentId = task.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  const modelRef = resolveSessionModelRef(cfg, entry, agentId, { allowPluginNormalization: false });
  const runtime = agentId
    ? resolveGatewaySessionThinkingProjection({
        cfg,
        provider: modelRef.provider,
        model: modelRef.model,
        agentId,
        sessionKey,
        entry,
      }).agentRuntime.id
    : undefined;
  const totalTokens = entry.totalTokens;
  const contextTokens = entry.contextTokens;
  const contextPercent =
    typeof totalTokens === "number" &&
    totalTokens >= 0 &&
    typeof contextTokens === "number" &&
    contextTokens > 0
      ? Math.min(100, Math.round((totalTokens / contextTokens) * 100))
      : undefined;
  const activeFallback = hasSessionActiveAutoModelFallback(entry);
  const hasTaskOverride =
    !activeFallback &&
    entry.modelOverrideSource === "user" &&
    Boolean(entry.providerOverride || entry.modelOverride);
  const requestedProvider = activeFallback
    ? technicalText(entry.modelOverrideFallbackOriginProvider)
    : technicalText(modelRef.provider);
  const requestedModel = activeFallback
    ? technicalText(entry.modelOverrideFallbackOriginModel)
    : technicalText(modelRef.model);
  const actualProvider = technicalText(entry.modelProvider);
  const actualModel = technicalText(entry.model);
  const actualObserved =
    entry.liveModelSwitchPending !== true && Boolean(actualProvider && actualModel);
  const actualMatchesRequest =
    actualObserved && actualProvider === requestedProvider && actualModel === requestedModel;
  const fastMode = resolveFastModeState({
    cfg,
    provider: modelRef.provider,
    model: modelRef.model,
    agentId,
    sessionEntry: entry,
  });
  const pacing = fastMode.mode === "auto" ? "auto" : fastMode.mode ? "fast" : "standard";
  const quotaLane =
    runtime === "codex" && entry.fastMode !== undefined
      ? entry.fastMode === "auto"
        ? "automatic"
        : entry.fastMode
          ? "priority"
          : "default"
      : undefined;
  const fallback = activeFallback
    ? "used"
    : hasTaskOverride
      ? "disabled"
      : hasConfiguredModelFallbacks({ cfg, agentId, sessionKey })
        ? "configured"
        : "disabled";
  return {
    provider: technicalText(modelRef.provider),
    model: technicalText(modelRef.model),
    runtime: technicalText(runtime),
    requestedProvider,
    requestedModel,
    actualProvider,
    actualModel,
    routeSource: activeFallback
      ? "automatic_fallback"
      : hasTaskOverride
        ? "task_override"
        : "agent_policy",
    exactModel: activeFallback
      ? "substituted"
      : hasTaskOverride
        ? actualObserved
          ? actualMatchesRequest
            ? "matched"
            : "substituted"
          : "unverified"
        : "not_requested",
    fallback,
    ...(activeFallback
      ? { fallbackReason: "Configured fallback selected; originating failure was not persisted." }
      : {}),
    pacing,
    pacingSource: fastMode.source,
    ...(quotaLane ? { quotaLane } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
  };
}

function authenticatedActorId(client: GatewayClient | null): string {
  const deviceId = client?.connect.device?.id;
  return deviceId ? `device:${deviceId}` : `gateway-connection:${client?.connId ?? "internal"}`;
}
function invalid(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  method: string,
  errors: unknown,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}
function execute(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  operation: () => unknown,
): void {
  try {
    respond(true, operation());
  } catch (error) {
    if (
      error instanceof WorkPlanConflictError ||
      error instanceof WorkPlanValidationError ||
      error instanceof WorkPlanNotFoundError
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return;
    }
    throw error;
  }
}

async function executeAsync(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    respond(true, await operation());
  } catch (error) {
    if (
      error instanceof WorkPlanConflictError ||
      error instanceof WorkPlanValidationError ||
      error instanceof WorkPlanNotFoundError
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return;
    }
    throw error;
  }
}

export function createWorkPlansHandlers(
  input: {
    repository?: WorkPlanRepository;
    projectContextRepository?: ProjectContextRepository;
    cancelTask?: typeof cancelDetachedTaskRunById;
    listTasks?: typeof listTaskRecords;
    listFlows?: typeof listTaskFlowRecords;
    inspectWorktree?: (id: string) => Promise<ManagedWorktreeInspection>;
  } = {},
): GatewayRequestHandlers {
  const repository = input.repository ?? new WorkPlanRepository();
  const projectContextRepository = input.projectContextRepository ?? new ProjectContextRepository();
  const cancelTask = input.cancelTask ?? cancelDetachedTaskRunById;
  const listTasks = input.listTasks ?? listTaskRecords;
  const listFlows = input.listFlows ?? listTaskFlowRecords;
  const inspectWorktree = input.inspectWorktree ?? ((id) => managedWorktrees.inspect(id));
  return {
    "work.registeredProjects.list": ({ params, respond }) => {
      if (!validateWorkRegisteredProjectsListParams(params)) {
        return invalid(
          respond,
          "work.registeredProjects.list",
          validateWorkRegisteredProjectsListParams.errors,
        );
      }
      execute(respond, () => ({ projects: projectContextRepository.listRegisteredProjects() }));
    },
    "work.registeredProjects.get": ({ params, respond }) => {
      if (!validateWorkRegisteredProjectsGetParams(params)) {
        return invalid(
          respond,
          "work.registeredProjects.get",
          validateWorkRegisteredProjectsGetParams.errors,
        );
      }
      execute(respond, () => ({
        project: projectContextRepository.getRegisteredProject(params.registeredProjectId),
      }));
    },
    "work.projects.createRegistered": ({ params, respond, client }) => {
      if (!validateWorkProjectsCreateRegisteredParams(params)) {
        return invalid(
          respond,
          "work.projects.createRegistered",
          validateWorkProjectsCreateRegisteredParams.errors,
        );
      }
      execute(respond, () =>
        projectContextRepository.createRegisteredWorkProject({
          ...params,
          actorId: authenticatedActorId(client),
        }),
      );
    },
    "work.projectContext.get": ({ params, respond }) => {
      if (!validateWorkProjectContextGetParams(params)) {
        return invalid(
          respond,
          "work.projectContext.get",
          validateWorkProjectContextGetParams.errors,
        );
      }
      execute(respond, () => ({
        context: projectContextRepository.getProjectContext(params.projectId),
      }));
    },
    "work.documents.list": ({ params, respond }) => {
      if (!validateWorkDocumentsListParams(params)) {
        return invalid(respond, "work.documents.list", validateWorkDocumentsListParams.errors);
      }
      execute(respond, () => ({
        documents: projectContextRepository.listDocuments(params.projectId),
      }));
    },
    "work.documents.get": ({ params, respond }) => {
      if (!validateWorkDocumentsGetParams(params)) {
        return invalid(respond, "work.documents.get", validateWorkDocumentsGetParams.errors);
      }
      execute(respond, () => ({
        document: projectContextRepository.getDocument(
          params.projectId,
          params.documentId,
          params.revision,
        ),
      }));
    },
    "work.capsules.update": ({ params, respond, client }) => {
      if (!validateWorkCapsulesUpdateParams(params)) {
        return invalid(respond, "work.capsules.update", validateWorkCapsulesUpdateParams.errors);
      }
      execute(respond, () =>
        projectContextRepository.updateCapsule({
          ...params,
          actorId: authenticatedActorId(client),
        }),
      );
    },
    "work.checkpoints.create": ({ params, respond, client }) => {
      if (!validateWorkCheckpointsCreateParams(params)) {
        return invalid(
          respond,
          "work.checkpoints.create",
          validateWorkCheckpointsCreateParams.errors,
        );
      }
      execute(respond, () =>
        projectContextRepository.createCheckpoint({
          ...params,
          actorId: authenticatedActorId(client),
        }),
      );
    },
    "work.handoffs.create": ({ params, respond, client }) => {
      if (!validateWorkHandoffsCreateParams(params)) {
        return invalid(respond, "work.handoffs.create", validateWorkHandoffsCreateParams.errors);
      }
      execute(respond, () =>
        projectContextRepository.createHandoff({
          ...params,
          actorId: authenticatedActorId(client),
        }),
      );
    },
    "work.projects.create": ({ params, respond, client }) => {
      if (!validateWorkProjectsCreateParams(params)) {
        return invalid(respond, "work.projects.create", validateWorkProjectsCreateParams.errors);
      }
      execute(respond, () =>
        repository.createProject({ ...params, actorId: authenticatedActorId(client) }),
      );
    },
    "work.projects.list": ({ params, respond }) => {
      if (!validateWorkProjectsListParams(params)) {
        return invalid(respond, "work.projects.list", validateWorkProjectsListParams.errors);
      }
      execute(respond, () => ({ projects: repository.listProjects() }));
    },
    "work.projects.get": async ({ params, respond, context }) => {
      if (!validateWorkProjectsGetParams(params)) {
        return invalid(respond, "work.projects.get", validateWorkProjectsGetParams.errors);
      }
      await executeAsync(respond, async () => {
        const project = repository.getProject(params.projectId);
        const tasks = listTasks();
        const flows = listFlows();
        const selectedPlan = currentWorkPlan(project);
        let sessionContext:
          | { cfg: OpenClawConfig; store: Record<string, SessionEntry> }
          | undefined;
        const resolveSessionFacts = (task: TaskRecord) => {
          if (!task.childSessionKey) {
            return {};
          }
          if (!sessionContext) {
            const cfg = context.getRuntimeConfig();
            sessionContext = {
              cfg,
              store: loadCombinedSessionStoreForGateway(cfg).store,
            };
          }
          return resolveWorkerSessionFacts(sessionContext.cfg, sessionContext.store, task);
        };
        return {
          project: {
            ...project,
            plans: await Promise.all(
              project.plans.map(async (plan) =>
                Object.assign({}, plan, {
                  workers: projectWorkPlanWorkers({ plan, tasks, resolveSessionFacts }),
                  orchestration:
                    selectedPlan?.planId === plan.planId
                      ? projectWorkPlanOrchestration({ plan, flows, tasks })
                      : [],
                  worktrees:
                    selectedPlan?.planId === plan.planId
                      ? await projectWorkPlanWorktrees({ plan, inspect: inspectWorktree })
                      : [],
                }),
              ),
            ),
          },
        };
      });
    },
    "work.workers.cancel": async ({ params, respond, context }) => {
      if (!validateWorkWorkersCancelParams(params)) {
        return invalid(respond, "work.workers.cancel", validateWorkWorkersCancelParams.errors);
      }
      const matches = repository
        .listProjects()
        .filter((project) => project.primaryConversationId === params.sessionKey);
      if (matches.length !== 1) {
        respond(true, { found: false, cancelled: false });
        return;
      }
      const project = repository.getProject(matches[0].projectId);
      const plan = currentWorkPlan(project);
      const task = plan
        ? resolveWorkPlanWorkerTask({
            plan,
            tasks: listTasks(),
            workerKey: params.workerKey,
          })
        : undefined;
      if (!task) {
        respond(true, { found: false, cancelled: false });
        return;
      }
      const result = await cancelTask({
        cfg: context.getRuntimeConfig(),
        taskId: task.taskId,
        reason: "Stopped from Assistant.",
      });
      respond(true, { found: result.found, cancelled: result.cancelled });
    },
    "work.plans.create": ({ params, respond, client }) => {
      if (!validateWorkPlansCreateParams(params)) {
        return invalid(respond, "work.plans.create", validateWorkPlansCreateParams.errors);
      }
      execute(respond, () => ({
        plan: repository.createPlan({ ...params, actorId: authenticatedActorId(client) }),
      }));
    },
    "work.plans.get": ({ params, respond }) => {
      if (!validateWorkPlansGetParams(params)) {
        return invalid(respond, "work.plans.get", validateWorkPlansGetParams.errors);
      }
      execute(respond, () => ({ plan: repository.getPlan(params.planId) }));
    },
    "work.plans.mutate": ({ params, respond, client }) => {
      if (!validateWorkPlansMutateParams(params)) {
        return invalid(respond, "work.plans.mutate", validateWorkPlansMutateParams.errors);
      }
      execute(respond, () => ({
        plan: repository.mutate({ ...params, actorId: authenticatedActorId(client) }),
      }));
    },
    "work.plans.history": ({ params, respond }) => {
      if (!validateWorkPlansHistoryParams(params)) {
        return invalid(respond, "work.plans.history", validateWorkPlansHistoryParams.errors);
      }
      execute(respond, () => ({
        transitions: repository.history(params.planId),
        lineage: repository.lineage(params.planId),
      }));
    },
    "work.plans.projection": ({ params, respond }) => {
      if (!validateWorkPlansProjectionParams(params)) {
        return invalid(respond, "work.plans.projection", validateWorkPlansProjectionParams.errors);
      }
      execute(respond, () => ({ projection: repository.getPlan(params.planId).projection }));
    },
  };
}

export const workPlansHandlers = createWorkPlansHandlers();
