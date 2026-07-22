import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import {
  canActivateLiveWorkContinue,
  createLiveWorkState,
  formatLiveWorkNumber,
  formatLiveWorkPlanStatus,
  isLiveWorkSessionArchived,
  normalizeLiveWork,
  presentLiveWorkView,
  refreshLiveWork,
  sanitizeLiveWorkDisplayText,
  shouldHandleChatPaneEscape,
  type LiveWorkContinueActivation,
} from "./chat-live-work.ts";

function project(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "opaque-project-id",
    primaryConversationId: "agent:main:main",
    recordRevision: 4,
    plans: [
      {
        planId: "opaque-plan-id",
        status: "ready",
        updatedAt: 10,
        recordRevision: 3,
        goal: { objective: "Ship the native work slice", recordRevision: 2 },
        projection: {
          display: "Plan 1/3",
          x: 1,
          n: 3,
          activeStepIds: ["step-secret-a"],
          readyStepIds: ["step-secret-b"],
        },
        steps: [
          {
            stepId: "step-secret-a",
            title: "Inspect the safe projection",
            status: "running",
            attempts: [{}],
          },
          {
            stepId: "step-secret-b",
            title: "Implement the next slice",
            status: "ready",
            attempts: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function context() {
  return {
    project: { recordRevision: 4 },
    registeredProject: { displayName: "Northstar", enabled: true },
    goal: { objective: "Ship the native work slice", recordRevision: 2 },
    capsule: {
      revision: 5,
      content: {
        summary: "Current work is bounded.",
        currentFocus: "Composer integration",
        explicitNextTask: "Prepare the focused UI change",
        constraints: ["Keep chat authoritative"],
        decisions: [],
        openQuestions: [],
        conflicts: [],
      },
    },
    capsuleProvenance: { state: "current" },
  };
}

describe("chat live work", () => {
  it("skips projection reads and clears presentation when hidden", async () => {
    const request = vi.fn();
    const state = createLiveWorkState();
    state.view = { kind: "plan", stale: false };

    await refreshLiveWork(
      state,
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      true,
      () => undefined,
      false,
    );

    expect(request).not.toHaveBeenCalled();
    expect(state.view).toBeNull();
  });
  it("selects one active plan, resolves step titles, and excludes opaque identifiers", () => {
    const view = normalizeLiveWork(project(), context());
    expect(view).toMatchObject({
      kind: "plan",
      projectName: "Northstar",
      planStatus: "ready",
      currentStep: "Inspect the safe projection",
      progressNow: 1,
      progressMax: 3,
    });
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("opaque-project-id");
    expect(rendered).not.toContain("opaque-plan-id");
    expect(rendered).not.toContain("step-secret");
  });

  it("projects dependencies, requirements, attempts, and checkpoint counts without identifiers", () => {
    const source = project();
    const plan = source.plans[0] as Record<string, unknown>;
    plan.definitionRevision = 9;
    plan.requirements = [
      {
        requirementId: "private-requirement",
        text: "Keep chat authoritative",
        disposition: "mapped",
        mappedStepId: "step-secret-a",
      },
      {
        requirementId: "private-unresolved",
        text: "Confirm the visual state",
        disposition: "unresolved",
      },
    ];
    plan.steps = [
      {
        stepId: "step-secret-a",
        ordinal: 1,
        title: "Inspect the safe projection",
        status: "succeeded",
        dependsOn: [],
        attempts: [
          {
            attemptId: "private-attempt",
            ownerId: "private-owner",
            attemptNumber: 1,
            ownerType: "codex",
            ownerState: "running",
            recoveryState: "reconciled-after-restart",
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      },
      {
        stepId: "step-secret-b",
        ordinal: 2,
        title: "Implement the next slice",
        status: "ready",
        dependsOn: ["step-secret-a"],
        attempts: [],
      },
    ];
    const sourceContext = context();
    Object.assign(sourceContext, {
      latestCheckpoint: {
        revision: 3,
        createdAt: 300,
        content: {
          exactNextAction: "Prepare the focused UI change",
          files: ["private-path"],
          tests: ["private-command"],
          blockers: ["private-error"],
        },
      },
      latestHandoff: { handoffId: "private-handoff" },
    });

    const view = normalizeLiveWork(source, sourceContext);
    expect(view).toMatchObject({
      attemptCount: 1,
      recoveryCount: 1,
      unresolvedRequirementCount: 1,
    });
    expect(view.details).toMatchObject({
      orderedSteps: [
        { title: "Inspect the safe projection", dependencies: [] },
        { title: "Implement the next slice", dependencies: ["Inspect the safe projection"] },
      ],
      requirements: {
        mapped: ["Keep chat authoritative"],
        unresolved: ["Confirm the visual state"],
      },
      checkpointEvidence: { files: 1, tests: 1, blockers: 1 },
      handoffPresent: true,
    });
    expect(view.details?.attempts?.[0]?.durationMs).toBeNull();
    const rendered = JSON.stringify(view);
    for (const secret of [
      "private-requirement",
      "private-unresolved",
      "private-attempt",
      "private-owner",
      "private-path",
      "private-command",
      "private-error",
      "private-handoff",
      "step-secret",
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("renders the server-projected worker facts without projection identifiers", () => {
    const source = project();
    const plan = source.plans[0] as Record<string, unknown>;
    plan.steps = [
      {
        stepId: "private-step",
        title: "Research the implementation",
        status: "running",
        attempts: [
          {
            attemptId: "private-attempt",
            ownerId: "private-task",
            attemptNumber: 1,
            ownerType: "task",
            ownerState: "running",
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      },
    ];
    plan.workers = [
      {
        key: "private-worker-key",
        label: "Research worker",
        ownerKind: "isolated",
        role: "Researcher",
        lane: "subagent",
        state: "running",
        health: "busy",
        provider: "openai",
        model: "gpt-5.6-terra",
        runtime: "codex",
        progress: "Comparing existing implementation seams.",
        contextPercent: 42,
        elapsedMs: 1250,
      },
    ];

    const view = normalizeLiveWork(source, context());

    expect(view.details?.workers).toEqual([
      expect.objectContaining({
        label: "Research worker",
        ownerKind: "isolated",
        role: "Researcher",
        lane: "subagent",
        state: "running",
        health: "busy",
        provider: "openai",
        model: "gpt-5.6-terra",
        runtime: "codex",
        progress: "Comparing existing implementation seams.",
        contextPercent: 42,
        elapsedMs: 1250,
      }),
    ]);
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("private-task");
    expect(rendered).not.toContain("private-child-session");
    expect(rendered).not.toContain("private-worker-key");
    expect(rendered).not.toContain("private-attempt");
    expect(rendered).not.toContain("private-step");
  });

  it("fails closed for project and active-plan ambiguity", async () => {
    expect(
      normalizeLiveWork(
        project({ plans: [...project().plans, { ...project().plans[0], updatedAt: 11 }] }),
        context(),
      ).kind,
    ).toBe("ambiguous-plans");

    const request = vi.fn(async (method: string) => {
      if (method === "work.projects.list") {
        return { projects: [project(), project({ projectId: "other" })] };
      }
      throw new Error("unexpected request");
    });
    const state = createLiveWorkState();
    await refreshLiveWork(
      state,
      { request } as unknown as GatewayBrowserClient,
      "main",
      true,
      () => undefined,
    );
    expect(state.view?.kind).toBe("ambiguous-projects");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("orders list, project, and context requests and ignores a late prior-session response", async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstList = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const calls: string[] = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === "work.projects.list" && calls.length === 1) {
        return firstList;
      }
      if (method === "work.projects.list") {
        return { projects: [project({ primaryConversationId: "agent:main:second" })] };
      }
      if (method === "work.projects.get") {
        return { project: project({ primaryConversationId: "agent:main:second" }) };
      }
      if (method === "work.projectContext.get") {
        return { context: context() };
      }
      throw new Error("unexpected request");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createLiveWorkState();
    const first = refreshLiveWork(state, client, "agent:main:first", true, () => undefined);
    const second = refreshLiveWork(state, client, "agent:main:second", true, () => undefined);
    await second;
    resolveFirst({ projects: [project({ primaryConversationId: "agent:main:first" })] });
    await first;
    expect(state.sessionKey).toBe("agent:main:second");
    expect(state.view?.kind).toBe("plan");
    expect(calls.slice(1).map((entry) => entry.split(":")[0])).toEqual([
      "work.projects.list",
      "work.projects.get",
      "work.projectContext.get",
    ]);
  });

  it("keeps stale capsule provenance non-actionable", () => {
    const stale = context();
    stale.capsuleProvenance.state = "stale";
    const view = normalizeLiveWork(project(), stale);
    expect(view.continueDraft).toBeUndefined();
    expect(view.details?.provenanceStatus).toBe("stale");
  });

  it("redacts human text and does not cross-match another agent's main session", async () => {
    const unsafe = context();
    unsafe.capsule.content.summary =
      "Use /private/repo/file.ts then bash -lc 'pnpm test' SECRET_TOKEN=sk-1234567890abcdef";
    const view = normalizeLiveWork(project(), unsafe);
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("/private/repo/file.ts");
    expect(rendered).not.toContain("pnpm test");
    expect(rendered).not.toContain("bash -lc");
    expect(rendered).not.toContain("sk-1234567890abcdef");

    const request = vi.fn(async () => ({
      projects: [project({ primaryConversationId: "main" })],
    }));
    const state = createLiveWorkState();
    await refreshLiveWork(
      state,
      { request } as unknown as GatewayBrowserClient,
      "agent:other:main",
      true,
      () => undefined,
    );
    expect(state.view).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    "README.md",
    "src/work/runner.ts",
    "/private/repo/file.ts",
    "C:\\Users\\operator\\secret.txt",
    "\\\\server\\share\\private.docx",
    "`cargo test --workspace`",
    "openclaw gateway restart",
    "pytest -q tests/private_test.py",
    "go test ./...",
    "pip install private-package",
    "dotnet test private.sln",
    "echo private | tee output.txt",
    "echo private",
    "cat secrets",
    "ls -la",
    ".env",
    "project-abc12345",
    "550e8400-e29b-41d4-a716-446655440000",
    "opaqueProjectIdentifier1234567890",
  ])("collapses unsafe presentation-only text to a localized fallback: %s", (unsafeText) => {
    expect(sanitizeLiveWorkDisplayText(unsafeText, "Safe fallback")).toBe("Safe fallback");
  });

  it.each([
    ["OpenClaw Main Workspace", "title" as const],
    ["Implement native live work strip", "title" as const],
    ["Current work is bounded and ready for review.", "narrative" as const],
  ])("preserves safe typed presentation text: %s", (safeText, kind) => {
    expect(sanitizeLiveWorkDisplayText(safeText, "Safe fallback", kind)).toBe(safeText);
  });

  it("sanitizes every rendered project, capsule, goal, checkpoint, and step label", () => {
    const unsafeContext = context();
    unsafeContext.registeredProject.displayName = "README.md";
    unsafeContext.goal.objective = "550e8400-e29b-41d4-a716-446655440000";
    unsafeContext.capsule.content.summary = "Run pytest -q tests/private_test.py";
    unsafeContext.capsule.content.currentFocus = "src/private/focus.ts";
    unsafeContext.capsule.content.explicitNextTask = "`cargo test --workspace`";
    Object.assign(unsafeContext, {
      latestCheckpoint: { content: { exactNextAction: "C:\\private\\next.ps1" } },
    });
    const unsafeProject = project({
      plans: [
        {
          ...project().plans[0],
          goal: { objective: "openclaw gateway restart", recordRevision: 2 },
          steps: [
            {
              stepId: "step-secret-a",
              title: "\\\\server\\share\\active.txt",
              status: "running",
              attempts: [],
            },
            {
              stepId: "step-secret-b",
              title: "opaqueStepIdentifier1234567890",
              status: "ready",
              attempts: [],
            },
          ],
        },
      ],
    });
    const rendered = JSON.stringify(normalizeLiveWork(unsafeProject, unsafeContext));
    for (const forbidden of [
      "README.md",
      "pytest",
      "private_test.py",
      "src/private",
      "cargo test",
      "550e8400",
      "C:\\\\private",
      "server\\\\share",
      "opaqueStepIdentifier",
      "openclaw gateway",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(rendered).toContain(t("chat.liveWork.registeredProject"));
    expect(rendered).toContain(t("chat.liveWork.redactedDetail"));
  });

  it("fails closed when capsule provenance is absent or unknown", () => {
    const absent = context();
    delete (absent as { capsuleProvenance?: unknown }).capsuleProvenance;
    const absentView = normalizeLiveWork(project(), absent);
    expect(absentView.details?.provenanceStatus).toBe("unavailable");
    expect(absentView.continueDraft).toBeUndefined();

    const unknown = context();
    unknown.capsuleProvenance.state = "future-state";
    const unknownView = normalizeLiveWork(project(), unknown);
    expect(unknownView.details?.provenanceStatus).toBe("unavailable");
    expect(unknownView.continueDraft).toBeUndefined();
  });

  it("never turns an unsafe explicit next task into an actionable redacted placeholder", () => {
    const unsafe = context();
    unsafe.capsule.content.explicitNextTask = "echo private";
    const view = normalizeLiveWork(project(), unsafe);
    expect(view.details?.nextTask).toBe(t("chat.liveWork.redactedDetail"));
    expect(view.details?.nextTaskSource).toBe("capsule");
    expect(view.continueDraft).toBeUndefined();
  });

  it.each([
    "running",
    "waiting",
    "blocked",
    "review",
    "unknown",
    "completed",
    "failed",
    "cancelled",
  ])("keeps %s plans read-only with an honest localized status", (status) => {
    const view = normalizeLiveWork(
      project({ plans: [{ ...project().plans[0], status }] }),
      context(),
    );
    expect(view).toMatchObject({ kind: "plan", planStatus: status });
    expect(view.continueDraft).toBeUndefined();
    expect(formatLiveWorkPlanStatus(view.planStatus ?? "unknown")).toBe(
      t(`chat.liveWork.status.${status}`),
    );
    if (["completed", "failed", "cancelled"].includes(status)) {
      expect(formatLiveWorkPlanStatus(view.planStatus ?? "unknown")).not.toBe(
        t("chat.liveWork.status.running"),
      );
    }
  });

  it("retains the authoritative plan detail when project context is unavailable", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "work.projects.list") {
        return { projects: [project()] };
      }
      if (method === "work.projects.get") {
        return { project: project() };
      }
      if (method === "work.projectContext.get") {
        throw new Error("localized provider prose that must not be parsed");
      }
      throw new Error("unexpected request");
    });
    const state = createLiveWorkState();
    await refreshLiveWork(
      state,
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      true,
      () => undefined,
    );
    expect(state.view).toMatchObject({
      kind: "plan",
      stale: false,
      progressNow: 1,
      progressMax: 3,
      message: t("chat.liveWork.projectContextUnavailable"),
      details: {
        objective: "Ship the native work slice",
        planPosition: { x: 1, n: 3 },
      },
    });
    expect(state.view?.continueDraft).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps a same-session cached projection stale when a detail refresh fails", async () => {
    let failProject = false;
    const request = vi.fn(async (method: string) => {
      if (method === "work.projects.list") {
        return { projects: [project()] };
      }
      if (method === "work.projects.get") {
        if (failProject) {
          throw new Error("SECRET_TOKEN=should-never-render");
        }
        return { project: project() };
      }
      if (method === "work.projectContext.get") {
        return { context: context() };
      }
      throw new Error("unexpected request");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createLiveWorkState();
    await refreshLiveWork(state, client, "agent:main:main", true, () => undefined);
    const cachedDetails = state.view?.details;
    failProject = true;
    await refreshLiveWork(state, client, "agent:main:main", true, () => undefined);
    expect(state.view).toMatchObject({
      kind: "plan",
      stale: true,
      message: t("chat.liveWork.refreshFailed"),
    });
    expect(state.view?.details).toBe(cachedDetails);
    expect(JSON.stringify(state.view)).not.toContain("SECRET_TOKEN");
  });

  it("keeps cached registered context stale when only the context refresh fails", async () => {
    let failContext = false;
    const request = vi.fn(async (method: string) => {
      if (method === "work.projects.list") {
        return { projects: [project()] };
      }
      if (method === "work.projects.get") {
        return { project: project() };
      }
      if (method === "work.projectContext.get") {
        if (failContext) {
          throw new Error("context temporarily unavailable");
        }
        return { context: context() };
      }
      throw new Error("unexpected request");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createLiveWorkState();
    await refreshLiveWork(state, client, "agent:main:main", true, () => undefined);
    const cached = state.view;
    failContext = true;
    await refreshLiveWork(state, client, "agent:main:main", true, () => undefined);
    expect(state.view).toMatchObject({
      kind: "plan",
      projectName: "Northstar",
      stale: true,
      message: t("chat.liveWork.projectContextUnavailable"),
    });
    expect(state.view?.details).toBe(cached?.details);
  });

  it("uses a generic localized error and never exposes Gateway error prose", async () => {
    const request = vi.fn(async () => {
      throw new Error("/private/path SECRET_TOKEN=sk-provider-secret");
    });
    const state = createLiveWorkState();
    await refreshLiveWork(
      state,
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      true,
      () => undefined,
    );
    expect(state.view).toEqual({
      kind: "error",
      stale: false,
      message: t("chat.liveWork.refreshFailed"),
    });
  });

  it("clears prior-session cached work when switching while disconnected", async () => {
    const state = createLiveWorkState();
    state.sessionKey = "agent:main:first";
    state.loading = true;
    state.view = normalizeLiveWork(project(), context());
    await refreshLiveWork(state, null, "agent:main:second", false, () => undefined);
    expect(state.view).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("rechecks every Continue precondition at activation time", () => {
    const client = {} as GatewayBrowserClient;
    const view = normalizeLiveWork(project(), context());
    const baseline: LiveWorkContinueActivation = {
      paneActive: true,
      paneConnected: true,
      expectedSessionKey: "agent:main:main",
      currentSessionKey: "agent:main:main",
      expectedRequestVersion: 7,
      currentRequestVersion: 7,
      expectedClient: client,
      currentClient: client,
      loading: false,
      connected: true,
      archived: false,
      runActive: false,
      sending: false,
      composing: false,
      stateDraft: "",
      liveDraft: "",
      expectedView: view,
      currentView: view,
      draft: view.continueDraft ?? "",
    };
    expect(canActivateLiveWorkContinue(baseline)).toBe(true);
    const otherClient = {} as GatewayBrowserClient;
    const otherView = { ...view };
    const rejected: LiveWorkContinueActivation[] = [
      { ...baseline, paneActive: false },
      { ...baseline, paneConnected: false },
      { ...baseline, currentSessionKey: "agent:main:other" },
      { ...baseline, currentRequestVersion: 8 },
      { ...baseline, currentClient: otherClient },
      { ...baseline, loading: true },
      { ...baseline, connected: false },
      { ...baseline, archived: true },
      { ...baseline, runActive: true },
      { ...baseline, sending: true },
      { ...baseline, composing: true },
      { ...baseline, stateDraft: "typed" },
      { ...baseline, liveDraft: "typed" },
      { ...baseline, currentView: otherView },
      {
        ...baseline,
        expectedView: { ...view, stale: true },
        currentView: { ...view, stale: true },
      },
      { ...baseline, draft: "different draft" },
    ];
    for (const candidate of rejected) {
      expect(canActivateLiveWorkContinue(candidate)).toBe(false);
    }
  });

  it("only lets the active pane handle Escape", () => {
    expect(shouldHandleChatPaneEscape(true)).toBe(true);
    expect(shouldHandleChatPaneEscape(false)).toBe(false);
  });

  it("marks retained work visibly stale and disables Continue while refresh is in flight", async () => {
    let releaseList!: (value: unknown) => void;
    let deferred = false;
    const request = vi.fn(async (method: string) => {
      if (method === "work.projects.list") {
        if (deferred) {
          return new Promise((resolve) => {
            releaseList = resolve;
          });
        }
        return { projects: [project()] };
      }
      if (method === "work.projects.get") {
        return { project: project() };
      }
      if (method === "work.projectContext.get") {
        return { context: context() };
      }
      throw new Error("unexpected request");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createLiveWorkState();
    await refreshLiveWork(state, client, "agent:main:main", true, () => undefined);
    const cached = state.view!;
    deferred = true;
    const refresh = refreshLiveWork(state, client, "agent:main:main", true, () => undefined);

    expect(state.loading).toBe(true);
    expect(state.view).toBe(cached);
    expect(presentLiveWorkView(cached, state.loading)).toMatchObject({
      kind: "plan",
      stale: true,
      message: t("chat.liveWork.loading"),
    });
    expect(
      canActivateLiveWorkContinue({
        paneActive: true,
        paneConnected: true,
        expectedSessionKey: state.sessionKey,
        currentSessionKey: state.sessionKey,
        expectedRequestVersion: state.requestVersion,
        currentRequestVersion: state.requestVersion,
        expectedClient: client,
        currentClient: client,
        loading: state.loading,
        connected: true,
        archived: false,
        runActive: false,
        sending: false,
        composing: false,
        stateDraft: "",
        liveDraft: "",
        expectedView: cached,
        currentView: state.view,
        draft: cached.continueDraft ?? "",
      }),
    ).toBe(false);

    releaseList({ projects: [project()] });
    await refresh;
    expect(state.loading).toBe(false);
  });

  it("recomputes archive ownership after render-time state changes", () => {
    const sessions = [{ key: "agent:main:main", archived: false }];
    expect(isLiveWorkSessionArchived(false, sessions, "agent:main:main")).toBe(false);
    sessions[0].archived = true;
    expect(isLiveWorkSessionArchived(false, sessions, "agent:main:main")).toBe(true);
  });

  it("formats plan progress with locale-aware numerals", () => {
    expect(formatLiveWorkNumber(1_234, "de")).toBe("1.234");
    expect(formatLiveWorkNumber(1_234, "en")).toBe("1,234");
  });

  it("disables chat-main transition and sidebar animation for reduced motion", async () => {
    const css = await readFile("src/styles/chat/sidebar.css", "utf8");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const reducedMotion = css.slice(start, css.indexOf("@media", start + 1));
    expect(reducedMotion).toContain(".chat-main");
    expect(reducedMotion).toContain("transition: none");
    expect(reducedMotion).toContain(".chat-sidebar");
    expect(reducedMotion).toContain("animation: none");
  });
});
