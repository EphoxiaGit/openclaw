import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { i18n, t } from "../../../i18n/index.ts";
import { redactToolDetail } from "../../../lib/browser-redact.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { SidebarContent, WorkPlanSidebarContent } from "./chat-sidebar.ts";

type WireAttempt = {
  attemptNumber?: unknown;
  ownerType?: unknown;
  ownerId?: unknown;
  ownerState?: unknown;
  recoveryState?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  endedAt?: unknown;
};
type WireStep = {
  stepId?: unknown;
  ordinal?: unknown;
  title?: unknown;
  status?: unknown;
  dependsOn?: unknown;
  attempts?: unknown;
};
type WirePlan = {
  status?: unknown;
  updatedAt?: unknown;
  recordRevision?: unknown;
  definitionRevision?: unknown;
  requirements?: unknown;
  workers?: unknown;
  goal?: { objective?: unknown; recordRevision?: unknown };
  steps?: unknown;
  projection?: {
    display?: unknown;
    x?: unknown;
    n?: unknown;
    activeStepIds?: unknown;
    readyStepIds?: unknown;
  };
};
type WireProject = {
  projectId?: unknown;
  primaryConversationId?: unknown;
  recordRevision?: unknown;
  plans?: unknown;
};
type WireWorker = {
  key?: unknown;
  parentKey?: unknown;
  label?: unknown;
  ownerKind?: unknown;
  role?: unknown;
  lane?: unknown;
  state?: unknown;
  health?: unknown;
  provider?: unknown;
  model?: unknown;
  runtime?: unknown;
  progress?: unknown;
  result?: unknown;
  contextPercent?: unknown;
  elapsedMs?: unknown;
};
type WireContext = {
  project?: { recordRevision?: unknown };
  registeredProject?: { displayName?: unknown; enabled?: unknown };
  goal?: { objective?: unknown; recordRevision?: unknown };
  capsule?: {
    revision?: unknown;
    content?: {
      summary?: unknown;
      currentFocus?: unknown;
      explicitNextTask?: unknown;
      constraints?: unknown;
      decisions?: unknown;
      openQuestions?: unknown;
      conflicts?: unknown;
    };
  };
  capsuleProvenance?: { state?: unknown };
  latestCheckpoint?: {
    revision?: unknown;
    createdAt?: unknown;
    content?: {
      exactNextAction?: unknown;
      files?: unknown;
      tests?: unknown;
      blockers?: unknown;
    };
  };
  latestHandoff?: unknown;
};

export type LiveWorkView = {
  kind:
    | "loading"
    | "error"
    | "ambiguous-projects"
    | "legacy"
    | "ambiguous-plans"
    | "no-plan"
    | "plan";
  stale: boolean;
  message?: string;
  projectName?: string;
  planStatus?: WorkPlanStatus;
  currentStep?: string;
  parallelCount?: number;
  blockerCount?: number;
  recoveryCount?: number;
  unresolvedRequirementCount?: number;
  attemptCount?: number;
  progressNow?: number;
  progressMax?: number;
  continueDraft?: string;
  details?: WorkPlanSidebarContent;
};

export type LiveWorkState = {
  client: GatewayBrowserClient | null;
  sessionKey: string;
  requestVersion: number;
  loading: boolean;
  view: LiveWorkView | null;
};

export type LiveWorkProps = {
  view: LiveWorkView;
  canContinue: boolean;
  onContinue: (draft: string) => void;
  onOpenDetails: (content: SidebarContent) => void;
  onRefresh: () => void;
  announcement?: string;
  showContinueDraft?: boolean;
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "superseded"]);
const CONTINUE_ALLOWED = new Set<WorkPlanStatus>(["draft", "ready"]);
const WORK_PLAN_STATUSES = new Set([
  "draft",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

export type WorkPlanStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "unknown";

export type LiveWorkContinueActivation = {
  paneActive: boolean;
  paneConnected: boolean;
  expectedSessionKey: string;
  currentSessionKey: string;
  expectedRequestVersion: number;
  currentRequestVersion: number;
  expectedClient: GatewayBrowserClient | null;
  currentClient: GatewayBrowserClient | null;
  loading: boolean;
  connected: boolean;
  archived: boolean;
  runActive: boolean;
  sending: boolean;
  composing: boolean;
  stateDraft: string;
  liveDraft: string;
  expectedView: LiveWorkView;
  currentView: LiveWorkView | null;
  draft: string;
};

export function canActivateLiveWorkContinue(input: LiveWorkContinueActivation): boolean {
  return (
    input.paneActive &&
    input.paneConnected &&
    input.expectedSessionKey === input.currentSessionKey &&
    input.expectedRequestVersion === input.currentRequestVersion &&
    input.expectedClient !== null &&
    input.expectedClient === input.currentClient &&
    !input.loading &&
    input.connected &&
    !input.archived &&
    !input.runActive &&
    !input.sending &&
    !input.composing &&
    input.stateDraft.trim() === "" &&
    input.liveDraft.trim() === "" &&
    input.expectedView === input.currentView &&
    input.expectedView.kind === "plan" &&
    !input.expectedView.stale &&
    Boolean(input.expectedView.continueDraft) &&
    input.expectedView.continueDraft === input.draft
  );
}

export function shouldHandleChatPaneEscape(active: boolean): boolean {
  return active;
}

export function isLiveWorkSessionArchived(
  selectedSessionArchived: boolean,
  sessions: Array<{ key: string; archived?: boolean }> | undefined,
  sessionKey: string,
): boolean {
  return (
    selectedSessionArchived ||
    sessions?.some(
      (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, sessionKey),
    ) === true
  );
}

export function presentLiveWorkView(view: LiveWorkView, loading: boolean): LiveWorkView {
  return loading && view.kind !== "loading"
    ? { ...view, stale: true, message: t("chat.liveWork.loading") }
    : view;
}

export function formatLiveWorkNumber(value: number, locale = i18n.getLocale()): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatLiveWorkPlanPosition(x: number, n: number): string {
  return t("chat.liveWork.planPosition", {
    x: formatLiveWorkNumber(x),
    n: formatLiveWorkNumber(n),
  });
}

export function formatLiveWorkPlanStatus(status: WorkPlanStatus): string {
  return t(`chat.liveWork.status.${status}`);
}

export type LiveWorkPresentationKind = "title" | "narrative";

const PRESENTATION_LIMITS: Record<LiveWorkPresentationKind, { chars: number; words: number }> = {
  title: { chars: 160, words: 24 },
  narrative: { chars: 2_000, words: 240 },
};
const NATURAL_LANGUAGE_PRESENTATION = /^\p{L}[\p{L}\p{M}\p{N}\p{Zs}.,!?…:'’"“”()\-–—]*$/u;
const NATURAL_LANGUAGE_TOKEN_PUNCTUATION = /[.,!?…:'’"“”()\-–—]/gu;

function hasUppercaseNaturalLanguageLead(value: string): boolean {
  const first = value[0];
  const lower = first.toLocaleLowerCase();
  const upper = first.toLocaleUpperCase();
  return lower === upper || first === upper;
}

export function sanitizeLiveWorkDisplayText(
  value: unknown,
  fallback = "",
  kind: LiveWorkPresentationKind = "narrative",
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  const limits = PRESENTATION_LIMITS[kind];
  if (
    !normalized ||
    normalized.length > limits.chars ||
    normalized.split(" ").length > limits.words ||
    redactToolDetail(normalized) !== normalized ||
    !NATURAL_LANGUAGE_PRESENTATION.test(normalized) ||
    !hasUppercaseNaturalLanguageLead(normalized) ||
    /\p{L}\.\p{L}/u.test(normalized)
  ) {
    return fallback;
  }
  for (const token of normalized.split(" ")) {
    const lexical = token.replace(NATURAL_LANGUAGE_TOKEN_PUNCTUATION, "");
    if (lexical.length > 40) {
      return fallback;
    }
    if (/\p{N}/u.test(lexical) && !/^\p{N}+$/u.test(lexical)) {
      return fallback;
    }
  }
  return normalized;
}

const safeTitle = (value: unknown, fallback = "") =>
  sanitizeLiveWorkDisplayText(value, fallback, "title");
const safeNarrative = (value: unknown, fallback = "") =>
  sanitizeLiveWorkDisplayText(value, fallback, "narrative");
type OptionalTitle = { display: string; accepted: string; rejected: boolean };

function safeOptionalTitle(value: unknown): OptionalTitle {
  if (typeof value !== "string" || !value.trim()) {
    return { display: "", accepted: "", rejected: false };
  }
  const accepted = safeTitle(value);
  return accepted
    ? { display: accepted, accepted, rejected: false }
    : { display: t("chat.liveWork.redactedDetail"), accepted: "", rejected: true };
}

function machineText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function planStatus(value: unknown): WorkPlanStatus {
  return typeof value === "string" && WORK_PLAN_STATUSES.has(value)
    ? (value as WorkPlanStatus)
    : "unknown";
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => safeNarrative(entry))
        .filter(Boolean)
        .slice(0, 50)
    : [];
}

const STEP_STATUSES = new Set([
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "superseded",
]);
const OWNER_TYPES = new Set(["task", "task_flow", "codex", "omx", "external"]);
const OWNER_STATES = new Set([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
  "unknown",
]);
const WORKER_STATES = new Set([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "unknown",
]);
const WORKER_HEALTH = new Set([
  "available",
  "busy",
  "degraded",
  "unavailable",
  "disabled",
  "misconfigured",
  "quota_exhausted",
  "authentication_required",
  "runtime_unavailable",
  "unknown",
]);
const WORKER_OWNER_KINDS = new Set(["inline", "isolated", "durable_job", "unknown"]);
const TECHNICAL_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function allowlisted(value: unknown, values: Set<string>, fallback = "unknown"): string {
  return typeof value === "string" && values.has(value) ? value : fallback;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function technicalText(value: unknown): string {
  return typeof value === "string" && TECHNICAL_TEXT.test(value) ? value : "";
}

function normalizeWorkers(plan: WirePlan): NonNullable<WorkPlanSidebarContent["workers"]> {
  const workers = Array.isArray(plan.workers) ? (plan.workers as WireWorker[]).slice(0, 100) : [];
  const labelByKey = new Map(
    workers.flatMap((worker) =>
      typeof worker.key === "string" ? [[worker.key, safeTitle(worker.label)] as const] : [],
    ),
  );
  return workers.map((worker, index) => ({
    label:
      safeTitle(worker.label) ||
      t("chat.liveWork.detail.workerNumber", { number: formatLiveWorkNumber(index + 1) }),
    parentLabel:
      typeof worker.parentKey === "string" ? (labelByKey.get(worker.parentKey) ?? null) : null,
    ownerKind: allowlisted(worker.ownerKind, WORKER_OWNER_KINDS),
    role: technicalText(worker.role) || "unknown",
    lane: technicalText(worker.lane) || "unknown",
    state: allowlisted(worker.state, WORKER_STATES),
    health: allowlisted(worker.health, WORKER_HEALTH),
    provider: technicalText(worker.provider),
    model: technicalText(worker.model),
    runtime: technicalText(worker.runtime),
    progress: safeNarrative(worker.progress),
    result: safeNarrative(worker.result),
    contextPercent:
      typeof worker.contextPercent === "number" &&
      Number.isInteger(worker.contextPercent) &&
      worker.contextPercent >= 0 &&
      worker.contextPercent <= 100
        ? worker.contextPercent
        : null,
    elapsedMs:
      typeof worker.elapsedMs === "number" && Number.isFinite(worker.elapsedMs)
        ? Math.max(0, worker.elapsedMs)
        : null,
  }));
}

function selectPlan(
  plans: WirePlan[],
): { kind: "none" } | { kind: "ambiguous" } | { kind: "selected"; plan: WirePlan } {
  const active = plans.filter((plan) => !TERMINAL.has(machineText(plan.status)));
  if (active.length > 1) {
    return { kind: "ambiguous" };
  }
  if (active.length === 1) {
    return { kind: "selected", plan: active[0] };
  }
  const terminal = plans
    .filter((plan) => machineText(plan.status) !== "superseded")
    .toSorted((left, right) => number(right.updatedAt) - number(left.updatedAt));
  return terminal[0] ? { kind: "selected", plan: terminal[0] } : { kind: "none" };
}

function stepTitles(plan: WirePlan, ids: unknown, fallback: string): string[] {
  const requested = new Set(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  );
  return Array.isArray(plan.steps)
    ? (plan.steps as WireStep[])
        .filter((step) => typeof step.stepId === "string" && requested.has(step.stepId))
        .map((step) => safeTitle(step.title, fallback))
        .filter(Boolean)
    : [];
}

export function normalizeLiveWork(project: WireProject, context: WireContext | null): LiveWorkView {
  const plans = Array.isArray(project.plans) ? (project.plans as WirePlan[]) : [];
  const selected = selectPlan(plans);
  const projectName = context
    ? safeTitle(context.registeredProject?.displayName, t("chat.liveWork.registeredProject"))
    : t("chat.liveWork.registeredProject");
  if (selected.kind === "ambiguous") {
    return {
      kind: "ambiguous-plans",
      stale: false,
      projectName,
      message: t("chat.liveWork.planAmbiguous"),
    };
  }
  if (selected.kind === "none") {
    return {
      kind: context ? "no-plan" : "legacy",
      stale: false,
      projectName,
      message: t(context ? "chat.liveWork.noPlan" : "chat.liveWork.projectContextUnavailable"),
    };
  }
  const plan = selected.plan;
  const projection = plan.projection ?? {};
  const redactedDetail = t("chat.liveWork.redactedDetail");
  const active = stepTitles(plan, projection.activeStepIds, redactedDetail);
  const ready = stepTitles(plan, projection.readyStepIds, redactedDetail);
  const acceptedReady = stepTitles(plan, projection.readyStepIds, "");
  const blocked = Array.isArray(plan.steps)
    ? (plan.steps as WireStep[])
        .filter((step) => machineText(step.status) === "blocked")
        .map((step) => safeTitle(step.title, redactedDetail))
        .filter(Boolean)
    : [];
  const provenanceStatus = !context?.capsule
    ? "unavailable"
    : context.capsuleProvenance?.state === "current"
      ? "current"
      : context.capsuleProvenance?.state === "stale"
        ? "stale"
        : "unavailable";
  const capsuleFresh = provenanceStatus === "current";
  const capsuleCandidate = capsuleFresh
    ? safeOptionalTitle(context?.capsule?.content?.explicitNextTask)
    : { display: "", accepted: "", rejected: false };
  const checkpointCandidate = safeOptionalTitle(
    context?.latestCheckpoint?.content?.exactNextAction,
  );
  const capsuleNext = capsuleCandidate.display;
  const checkpointNext = checkpointCandidate.display;
  const nextTask = capsuleNext || checkpointNext || ready[0] || "";
  const actionCandidateRejected =
    capsuleCandidate.rejected ||
    (!capsuleCandidate.accepted && checkpointCandidate.rejected) ||
    acceptedReady.length !== ready.length;
  const actionableNextTask = actionCandidateRejected
    ? ""
    : capsuleCandidate.accepted || checkpointCandidate.accepted || acceptedReady[0] || "";
  const status = planStatus(plan.status);
  const progressNow = number(projection.x);
  const progressMax = Math.max(1, number(projection.n, 1));
  const wireSteps = Array.isArray(plan.steps) ? (plan.steps as WireStep[]) : [];
  const titleById = new Map(
    wireSteps.flatMap((step) =>
      typeof step.stepId === "string"
        ? [[step.stepId, safeTitle(step.title, redactedDetail)] as const]
        : [],
    ),
  );
  const orderedSteps = wireSteps
    .map((step, index) => ({
      title: safeTitle(step.title, redactedDetail),
      ordinal: Math.max(1, number(step.ordinal, index + 1)),
      status: allowlisted(step.status, STEP_STATUSES),
      dependencies: Array.isArray(step.dependsOn)
        ? step.dependsOn
            .flatMap((id) =>
              typeof id === "string" && titleById.has(id) ? [titleById.get(id)!] : [],
            )
            .slice(0, 20)
        : [],
    }))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const attempts = wireSteps
    .flatMap((step) => (Array.isArray(step.attempts) ? (step.attempts as WireAttempt[]) : []))
    .map((attempt) => {
      const createdAt = timestamp(attempt.createdAt);
      const endedAt = timestamp(attempt.endedAt);
      const updatedAt = timestamp(attempt.updatedAt);
      return {
        attemptNumber: Math.max(1, number(attempt.attemptNumber, 1)),
        ownerType: allowlisted(attempt.ownerType, OWNER_TYPES),
        ownerState: allowlisted(attempt.ownerState, OWNER_STATES),
        recoveryState: (typeof attempt.recoveryState === "string" ? "present" : "none") as
          | "present"
          | "none",
        createdAt,
        updatedAt,
        endedAt,
        durationMs: createdAt && endedAt ? Math.max(0, endedAt - createdAt) : null,
      };
    });
  const requirements = Array.isArray(plan.requirements)
    ? (plan.requirements as Array<{ text?: unknown; disposition?: unknown }>).map(
        (requirement) => ({
          text: safeNarrative(requirement.text, redactedDetail),
          disposition:
            requirement.disposition === "mapped" ||
            requirement.disposition === "excluded" ||
            requirement.disposition === "unresolved"
              ? requirement.disposition
              : "unresolved",
        }),
      )
    : [];
  const checkpoint = context?.latestCheckpoint;
  const details: WorkPlanSidebarContent = {
    kind: "work-plan",
    title: t("chat.liveWork.detail.title", { project: projectName }),
    projectName,
    planPosition: { x: progressNow, n: progressMax },
    planStatus: status,
    summary: safeNarrative(context?.capsule?.content?.summary, t("chat.liveWork.noSummary")),
    focus: safeTitle(context?.capsule?.content?.currentFocus, t("chat.liveWork.noFocus")),
    capsuleCounts: {
      constraints: list(context?.capsule?.content?.constraints).length,
      decisions: list(context?.capsule?.content?.decisions).length,
      openQuestions: list(context?.capsule?.content?.openQuestions).length,
      conflicts: list(context?.capsule?.content?.conflicts).length,
    },
    provenanceStatus,
    objective: safeNarrative(
      context?.goal?.objective ?? plan.goal?.objective,
      t("chat.liveWork.noObjective"),
    ),
    activeSteps: active,
    readySteps: ready,
    blockedSteps: blocked,
    orderedSteps,
    attempts,
    workers: normalizeWorkers(plan),
    requirements: {
      mapped: requirements.filter((item) => item.disposition === "mapped").map((item) => item.text),
      excluded: requirements
        .filter((item) => item.disposition === "excluded")
        .map((item) => item.text),
      unresolved: requirements
        .filter((item) => item.disposition === "unresolved")
        .map((item) => item.text),
    },
    evidenceCount: 0,
    checkpointEvidence: {
      files: Array.isArray(checkpoint?.content?.files) ? checkpoint.content.files.length : 0,
      tests: Array.isArray(checkpoint?.content?.tests) ? checkpoint.content.tests.length : 0,
      blockers: Array.isArray(checkpoint?.content?.blockers)
        ? checkpoint.content.blockers.length
        : 0,
    },
    revisions: {
      project: number(project.recordRevision),
      plan: number(plan.recordRevision),
      definition: number(plan.definitionRevision),
      goal: number(context?.goal?.recordRevision ?? plan.goal?.recordRevision),
      capsule: number(context?.capsule?.revision),
    },
    updatedAt: timestamp(plan.updatedAt),
    checkpointPresent: Boolean(context?.latestCheckpoint),
    handoffPresent: Boolean(context?.latestHandoff),
    nextTask: nextTask || t("chat.liveWork.noNextTask"),
    nextTaskSource: capsuleNext
      ? "capsule"
      : checkpointNext
        ? "checkpoint"
        : ready[0]
          ? "ready-step"
          : "none",
  };
  const continueAllowed =
    Boolean(context?.registeredProject?.enabled) &&
    capsuleFresh &&
    acceptedReady.length > 0 &&
    Boolean(actionableNextTask) &&
    CONTINUE_ALLOWED.has(status);
  return {
    kind: "plan",
    stale: false,
    projectName,
    planStatus: status,
    currentStep: active[0] ?? ready[0] ?? t("chat.liveWork.noCurrentStep"),
    parallelCount: Math.max(0, active.length - 1),
    blockerCount: blocked.length,
    recoveryCount: attempts.filter((attempt) => attempt.recoveryState === "present").length,
    unresolvedRequirementCount: requirements.filter(
      (requirement) => requirement.disposition === "unresolved",
    ).length,
    attemptCount: attempts.length,
    progressNow,
    progressMax,
    ...(!context ? { message: t("chat.liveWork.projectContextUnavailable") } : {}),
    ...(continueAllowed
      ? {
          continueDraft: t("chat.liveWork.continuationDraft", {
            project: projectName,
            task: actionableNextTask,
          }).slice(0, 1_000),
        }
      : {}),
    details,
  };
}

export function createLiveWorkState(): LiveWorkState {
  return { client: null, sessionKey: "", requestVersion: 0, loading: false, view: null };
}

export async function refreshLiveWork(
  state: LiveWorkState,
  client: GatewayBrowserClient | null,
  sessionKey: string,
  connected: boolean,
  requestUpdate: () => void,
  visible = true,
): Promise<void> {
  const sessionChanged = Boolean(
    state.sessionKey && !areUiSessionKeysEquivalent(state.sessionKey, sessionKey),
  );
  if (sessionChanged) {
    state.view = null;
  }
  state.client = client;
  state.sessionKey = sessionKey;
  const version = ++state.requestVersion;
  if (!visible) {
    state.loading = false;
    state.view = null;
    requestUpdate();
    return;
  }
  if (!client || !connected) {
    state.loading = false;
    if (state.view) {
      state.view = {
        ...state.view,
        stale: true,
        message: t("chat.liveWork.disconnectedStale"),
      };
    }
    requestUpdate();
    return;
  }
  state.loading = true;
  requestUpdate();
  try {
    const listed = await client.request<{ projects?: WireProject[] }>("work.projects.list", {});
    if (
      version !== state.requestVersion ||
      state.client !== client ||
      state.sessionKey !== sessionKey
    ) {
      return;
    }
    const matches = (listed.projects ?? []).filter((project) =>
      areUiSessionKeysEquivalent(
        typeof project.primaryConversationId === "string" ? project.primaryConversationId : "",
        sessionKey,
      ),
    );
    if (matches.length === 0) {
      state.view = null;
      return;
    }
    if (matches.length > 1) {
      state.view = {
        kind: "ambiguous-projects",
        stale: false,
        message: t("chat.liveWork.projectAmbiguous"),
      };
      return;
    }
    if (!state.view) {
      state.view = { kind: "loading", stale: false, message: t("chat.liveWork.loading") };
      requestUpdate();
    }
    const projectId = typeof matches[0].projectId === "string" ? matches[0].projectId : "";
    const load = async () => {
      const project = (
        await client.request<{ project: WireProject }>("work.projects.get", { projectId })
      ).project;
      let context: WireContext | null = null;
      let contextUnavailable = false;
      try {
        context = (
          await client.request<{ context: WireContext }>("work.projectContext.get", { projectId })
        ).context;
      } catch {
        contextUnavailable = true;
        // G004 remains independently readable when the optional G005 context
        // projection is unavailable for any reason. Never classify failures
        // by parsing localized or provider-supplied Gateway prose.
      }
      return { project, context, contextUnavailable };
    };
    let detail = await load();
    if (
      detail.context &&
      number(detail.project.recordRevision) !== number(detail.context.project?.recordRevision)
    ) {
      detail = await load();
      if (
        detail.context &&
        number(detail.project.recordRevision) !== number(detail.context.project?.recordRevision)
      ) {
        throw new Error(t("chat.liveWork.revisionMismatch"));
      }
    }
    if (
      version !== state.requestVersion ||
      state.client !== client ||
      state.sessionKey !== sessionKey
    ) {
      return;
    }
    if (detail.contextUnavailable && state.view && state.view.kind !== "loading") {
      state.view = {
        ...state.view,
        stale: true,
        message: t("chat.liveWork.projectContextUnavailable"),
      };
      return;
    }
    state.view = normalizeLiveWork(detail.project, detail.context);
  } catch {
    if (
      version !== state.requestVersion ||
      state.client !== client ||
      state.sessionKey !== sessionKey
    ) {
      return;
    }
    const message = t("chat.liveWork.refreshFailed");
    state.view =
      state.view && state.view.kind !== "loading"
        ? { ...state.view, stale: true, message }
        : { kind: "error", stale: false, message };
  } finally {
    if (version === state.requestVersion) {
      state.loading = false;
      requestUpdate();
    }
  }
}

export function renderLiveWorkStrip(
  props: LiveWorkProps | undefined,
): TemplateResult | typeof nothing {
  if (!props) {
    return nothing;
  }
  const view = props.view;
  const status = view.stale
    ? t("chat.liveWork.stale")
    : view.kind === "plan"
      ? formatLiveWorkPlanStatus(view.planStatus ?? "unknown")
      : view.kind === "loading"
        ? t("chat.liveWork.loading")
        : t("chat.liveWork.attention");
  return html` <section class="chat-live-work" aria-label=${t("chat.liveWork.region")}>
    <span class="agent-chat__sr-only" role="status" aria-live="polite" aria-atomic="true"
      >${props.announcement ?? ""}</span
    >
    <div class="chat-live-work__summary" role="status" aria-live="polite" aria-atomic="true">
      <strong>${status}</strong>${view.projectName
        ? html`<span>${view.projectName}</span>`
        : nothing}${view.progressNow !== undefined && view.progressMax !== undefined
        ? html`<span>${formatLiveWorkPlanPosition(view.progressNow, view.progressMax)}</span>`
        : nothing}${view.currentStep
        ? html`<span
            >${view.currentStep}${view.parallelCount
              ? ` ${t("chat.liveWork.parallel", {
                  count: formatLiveWorkNumber(view.parallelCount),
                })}`
              : ""}</span
          >`
        : nothing}${view.blockerCount
        ? html`<span
            >${t("chat.liveWork.detail.blockerCount", {
              count: formatLiveWorkNumber(view.blockerCount),
            })}</span
          >`
        : nothing}${view.recoveryCount
        ? html`<span
            >${t("chat.liveWork.detail.recoveryCount", {
              count: formatLiveWorkNumber(view.recoveryCount),
            })}</span
          >`
        : nothing}${view.unresolvedRequirementCount
        ? html`<span
            >${t("chat.liveWork.detail.unresolvedCount", {
              count: formatLiveWorkNumber(view.unresolvedRequirementCount),
            })}</span
          >`
        : nothing}${view.attemptCount
        ? html`<span
            >${t("chat.liveWork.detail.attemptCount", {
              count: formatLiveWorkNumber(view.attemptCount),
            })}</span
          >`
        : nothing}${view.message ? html`<span>${view.message}</span>` : nothing}
    </div>
    ${view.kind === "plan"
      ? html`<div
          class="chat-live-work__progress"
          role="progressbar"
          aria-label=${t("chat.liveWork.progress")}
          aria-valuemin="0"
          aria-valuemax=${view.progressMax ?? 1}
          aria-valuenow=${view.progressNow ?? 0}
        >
          <span
            style=${`width:${Math.min(100, ((view.progressNow ?? 0) / (view.progressMax ?? 1)) * 100)}%`}
          ></span>
        </div>`
      : nothing}
    <div class="chat-live-work__actions">
      ${view.details
        ? html`<button
            class="btn btn--sm chat-live-work__details"
            type="button"
            @click=${() => props.onOpenDetails(view.details!)}
          >
            ${t("chat.liveWork.openDetails")}
          </button>`
        : nothing}
      ${view.kind === "error" || view.stale
        ? html`<button class="btn btn--sm" type="button" @click=${props.onRefresh}>
            ${t("chat.liveWork.retry")}
          </button>`
        : nothing}
      ${view.kind === "plan" && props.showContinueDraft !== false
        ? html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${!props.canContinue || !view.continueDraft}
            @click=${() => view.continueDraft && props.onContinue(view.continueDraft)}
          >
            ${t("chat.liveWork.continue")}
          </button>`
        : nothing}
    </div>
  </section>`;
}
