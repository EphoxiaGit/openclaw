import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { redactToolDetail } from "../../../lib/browser-redact.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { SidebarContent, WorkPlanSidebarContent } from "./chat-sidebar.ts";

type WireStep = { stepId?: unknown; title?: unknown; status?: unknown; attempts?: unknown };
type WirePlan = {
  status?: unknown;
  updatedAt?: unknown;
  recordRevision?: unknown;
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
  planDisplay?: string;
  planStatus?: string;
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
const CONTINUE_BLOCKED = new Set(["running", "waiting", "blocked"]);

function safeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return redactToolDetail(value.trim())
    .replace(/(?:[a-z]:[\\/]|~?[\\/](?=[a-z_.-]))[^\s,;]+/gi, "[path omitted]")
    .replace(
      /(^|\n)\s*(?:\$\s*|pnpm\s+|npm\s+|git\s+|curl\s+|rm\s+|cd\s+)[^\n]+/gi,
      "$1[command omitted]",
    )
    .replace(/\b(?:pnpm|npm|git|curl|rm|cd)\s+[^.\n]+/gi, "[command omitted]")
    .slice(0, 4_000);
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
        .map((step) => safeText(step.title))
        .filter(Boolean)
    : [];
}

export function normalizeLiveWork(
  project: WireProject,
  context: WireContext | null,
  registrationDisabled = false,
): LiveWorkView {
  const plans = Array.isArray(project.plans) ? (project.plans as WirePlan[]) : [];
  const selected = selectPlan(plans);
  if (!context) {
    return {
      kind: "legacy",
      stale: false,
      message: t(
        registrationDisabled ? "chat.liveWork.registrationDisabled" : "chat.liveWork.legacy",
      ),
    };
  }
  const projectName = safeText(
    context.registeredProject?.displayName,
    t("chat.liveWork.registeredProject"),
  );
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
      kind: "no-plan",
      stale: false,
      projectName,
      message: t("chat.liveWork.noPlan"),
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
  const capsuleFresh = context.capsuleProvenance?.state !== "stale";
  const capsuleNext = capsuleFresh ? safeText(context.capsule?.content?.explicitNextTask) : "";
  const checkpointNext = safeText(context.latestCheckpoint?.content?.exactNextAction);
  const nextTask = capsuleNext || checkpointNext || ready[0] || "";
  const status = safeText(plan.status, "unknown");
  const details: WorkPlanSidebarContent = {
    kind: "work-plan",
    title: t("chat.liveWork.detail.title", { project: projectName }),
    projectName,
    planDisplay: safeText(projection.display, "Plan"),
    planStatus: status,
    summary: safeText(context.capsule?.content?.summary, t("chat.liveWork.noSummary")),
    focus: safeText(context.capsule?.content?.currentFocus, t("chat.liveWork.noFocus")),
    capsuleCounts: {
      constraints: list(context.capsule?.content?.constraints).length,
      decisions: list(context.capsule?.content?.decisions).length,
      openQuestions: list(context.capsule?.content?.openQuestions).length,
      conflicts: list(context.capsule?.content?.conflicts).length,
    },
    provenanceStatus: context.capsule ? (capsuleFresh ? "Current" : "Stale") : "Unavailable",
    objective: safeText(context.goal?.objective, t("chat.liveWork.noObjective")),
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
      goal: number(context.goal?.recordRevision),
      capsule: number(context.capsule?.revision),
    },
    checkpointPresent: Boolean(context.latestCheckpoint),
    nextTask: nextTask || t("chat.liveWork.noNextTask"),
    nextTaskSource: capsuleNext
      ? "Capsule"
      : checkpointNext
        ? "Checkpoint"
        : ready[0]
          ? "Ready step"
          : "None",
  };
  const continueAllowed =
    Boolean(context.registeredProject?.enabled) &&
    capsuleFresh &&
    ready.length > 0 &&
    Boolean(nextTask) &&
    !CONTINUE_BLOCKED.has(status) &&
    !TERMINAL.has(status);
  return {
    kind: "plan",
    stale: false,
    projectName,
    planDisplay: details.planDisplay,
    planStatus: status,
    currentStep: active[0] ?? ready[0] ?? t("chat.liveWork.noCurrentStep"),
    parallelCount: Math.max(0, active.length - 1),
    progressNow: number(projection.x),
    progressMax: Math.max(1, number(projection.n, 1)),
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
  state.client = client;
  state.sessionKey = sessionKey;
  const version = ++state.requestVersion;
  if (!client || !connected) {
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
    state.view = { kind: "loading", stale: false, message: t("chat.liveWork.loading") };
    requestUpdate();
    const projectId = typeof matches[0].projectId === "string" ? matches[0].projectId : "";
    const load = async () => {
      const project = (
        await client.request<{ project: WireProject }>("work.projects.get", { projectId })
      ).project;
      let context: WireContext | null = null;
      let registrationDisabled = false;
      try {
        context = (
          await client.request<{ context: WireContext }>("work.projectContext.get", { projectId })
        ).context;
      } catch (error) {
        const detail = String(error);
        registrationDisabled = detail.includes("registered project is disabled");
        if (!registrationDisabled && !detail.includes("not linked to a registered project")) {
          throw error;
        }
      }
      return { project, context, registrationDisabled };
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
    state.view = normalizeLiveWork(detail.project, detail.context, detail.registrationDisabled);
  } catch (error) {
    if (
      version !== state.requestVersion ||
      state.client !== client ||
      state.sessionKey !== sessionKey
    ) {
      return;
    }
    const message = t("chat.liveWork.refreshFailed", {
      message: redactToolDetail(error instanceof Error ? error.message : String(error)),
    });
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
      ? view.planStatus === "completed"
        ? t("chat.liveWork.complete")
        : view.planStatus === "blocked"
          ? t("chat.liveWork.blocked")
          : t("chat.liveWork.live")
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
        : nothing}${view.planDisplay
        ? html`<span>${view.planDisplay}</span>`
        : nothing}${view.currentStep
        ? html`<span
            >${view.currentStep}${view.parallelCount
              ? ` ${t("chat.liveWork.parallel", { count: String(view.parallelCount) })}`
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
