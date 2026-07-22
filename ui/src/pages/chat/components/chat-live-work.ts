import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { i18n, t } from "../../../i18n/index.ts";
import { redactToolDetail } from "../../../lib/browser-redact.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { SidebarContent, WorkPlanSidebarContent } from "./chat-sidebar.ts";

type WireStep = { stepId?: unknown; title?: unknown; status?: unknown; attempts?: unknown };
type WirePlan = {
  status?: unknown;
  updatedAt?: unknown;
  recordRevision?: unknown;
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
  latestCheckpoint?: { revision?: unknown; content?: { exactNextAction?: unknown } };
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

const COMMAND_INVOCATION =
  /(?:^|[\s:;(])(?:\$\s*|sudo\s+)?(?:(?:bash|sh|zsh|fish|powershell|pwsh|cmd)(?:\.exe)?\b|(?:openclaw|pnpm|npm|npx|yarn|bun|git|gh|curl|wget|rm|cp|mv|cd|node|deno|python\d*|pytest|pip\d*|pipx|poetry|uv|cargo|rustc|docker|podman|wrangler|ssh|scp|rsync|kubectl|helm|terraform|ansible|gradle|mvn|dotnet|java|javac|kotlin|swift|xcodebuild|ruby|bundle|rake|gem|php|composer|perl|gcc|g\+\+|clang|cmake|meson|ninja|nix|nix-shell|brew|apt|apt-get|dnf|yum|pacman|systemctl|service)\b|go\s+(?:build|clean|env|generate|get|install|list|mod|run|test|tool|version|work)\b|make(?:\s|$))/i;
const SHELL_SYNTAX = /(?:&&|\|\||\$\(|\${|[<>]|(?:^|\s)\|(?:\s|$))/;
const PATH_OR_FILENAME =
  /(?:\\\\[^\s\\/]+[\\/][^\s,;:()]+|[a-z]:[\\/][^\s,;:()]+|(?:~?[\\/]|\.\.?[\\/])[^\s,;:()]+|\b(?:[a-z0-9_.-]+[\\/])+(?:[a-z0-9_.-]+)\b|\b(?:readme|changelog|license|makefile|dockerfile)(?:\.[a-z0-9]+)?\b|\b[a-z0-9][a-z0-9_.-]{0,80}\.[a-z0-9]{1,10}\b)/gi;
const OPAQUE_IDENTIFIER =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[a-z0-9_-]{24,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+|(?:agent|session|project|plan|step|run):[a-z0-9:_-]{8,})\b/gi;

export function sanitizeLiveWorkDisplayText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const redacted = t("chat.liveWork.redactedDetail");
  const sanitized = redactToolDetail(value.trim())
    .replace(/```[\s\S]*?```/g, redacted)
    .replace(/`[^`\n]+`/g, redacted)
    .split(/\r?\n/)
    .map((line) => (COMMAND_INVOCATION.test(line) || SHELL_SYNTAX.test(line) ? redacted : line))
    .join("\n")
    .replace(PATH_OR_FILENAME, redacted)
    .replace(OPAQUE_IDENTIFIER, redacted)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
  const meaningful = sanitized
    .replaceAll(redacted, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  return meaningful ? sanitized : fallback;
}

const safeText = sanitizeLiveWorkDisplayText;

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
        .map((entry) => safeText(entry))
        .filter(Boolean)
        .slice(0, 50)
    : [];
}

function selectPlan(
  plans: WirePlan[],
): { kind: "none" } | { kind: "ambiguous" } | { kind: "selected"; plan: WirePlan } {
  const active = plans.filter((plan) => !TERMINAL.has(safeText(plan.status)));
  if (active.length > 1) {
    return { kind: "ambiguous" };
  }
  if (active.length === 1) {
    return { kind: "selected", plan: active[0] };
  }
  const terminal = plans
    .filter((plan) => safeText(plan.status) !== "superseded")
    .toSorted((left, right) => number(right.updatedAt) - number(left.updatedAt));
  return terminal[0] ? { kind: "selected", plan: terminal[0] } : { kind: "none" };
}

function stepTitles(plan: WirePlan, ids: unknown): string[] {
  const requested = new Set(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  );
  return Array.isArray(plan.steps)
    ? (plan.steps as WireStep[])
        .filter((step) => typeof step.stepId === "string" && requested.has(step.stepId))
        .map((step) => safeText(step.title, t("chat.liveWork.redactedDetail")))
        .filter(Boolean)
    : [];
}

export function normalizeLiveWork(project: WireProject, context: WireContext | null): LiveWorkView {
  const plans = Array.isArray(project.plans) ? (project.plans as WirePlan[]) : [];
  const selected = selectPlan(plans);
  const projectName = context
    ? safeText(context.registeredProject?.displayName, t("chat.liveWork.registeredProject"))
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
  const active = stepTitles(plan, projection.activeStepIds);
  const ready = stepTitles(plan, projection.readyStepIds);
  const blocked = Array.isArray(plan.steps)
    ? (plan.steps as WireStep[])
        .filter((step) => safeText(step.status) === "blocked")
        .map((step) => safeText(step.title))
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
  const capsuleNext = capsuleFresh ? safeText(context?.capsule?.content?.explicitNextTask) : "";
  const checkpointNext = safeText(context?.latestCheckpoint?.content?.exactNextAction);
  const nextTask = capsuleNext || checkpointNext || ready[0] || "";
  const status = planStatus(plan.status);
  const progressNow = number(projection.x);
  const progressMax = Math.max(1, number(projection.n, 1));
  const details: WorkPlanSidebarContent = {
    kind: "work-plan",
    title: t("chat.liveWork.detail.title", { project: projectName }),
    projectName,
    planPosition: { x: progressNow, n: progressMax },
    planStatus: status,
    summary: safeText(context?.capsule?.content?.summary, t("chat.liveWork.noSummary")),
    focus: safeText(context?.capsule?.content?.currentFocus, t("chat.liveWork.noFocus")),
    capsuleCounts: {
      constraints: list(context?.capsule?.content?.constraints).length,
      decisions: list(context?.capsule?.content?.decisions).length,
      openQuestions: list(context?.capsule?.content?.openQuestions).length,
      conflicts: list(context?.capsule?.content?.conflicts).length,
    },
    provenanceStatus,
    objective: safeText(
      context?.goal?.objective ?? plan.goal?.objective,
      t("chat.liveWork.noObjective"),
    ),
    activeSteps: active,
    readySteps: ready,
    blockedSteps: blocked,
    evidenceCount: Array.isArray(plan.steps)
      ? (plan.steps as WireStep[]).reduce(
          (sum, step) => sum + (Array.isArray(step.attempts) ? step.attempts.length : 0),
          0,
        )
      : 0,
    revisions: {
      project: number(project.recordRevision),
      plan: number(plan.recordRevision),
      goal: number(context?.goal?.recordRevision ?? plan.goal?.recordRevision),
      capsule: number(context?.capsule?.revision),
    },
    checkpointPresent: Boolean(context?.latestCheckpoint),
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
    ready.length > 0 &&
    Boolean(nextTask) &&
    CONTINUE_ALLOWED.has(status);
  return {
    kind: "plan",
    stale: false,
    projectName,
    planStatus: status,
    currentStep: active[0] ?? ready[0] ?? t("chat.liveWork.noCurrentStep"),
    parallelCount: Math.max(0, active.length - 1),
    progressNow,
    progressMax,
    ...(!context ? { message: t("chat.liveWork.projectContextUnavailable") } : {}),
    ...(continueAllowed
      ? {
          continueDraft: t("chat.liveWork.continuationDraft", {
            project: projectName,
            task: nextTask,
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
      ${view.kind === "plan"
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
