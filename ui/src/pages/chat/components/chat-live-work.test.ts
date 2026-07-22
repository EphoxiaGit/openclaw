import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { createLiveWorkState, normalizeLiveWork, refreshLiveWork } from "./chat-live-work.ts";

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
  it("selects one active plan, resolves step titles, and excludes opaque identifiers", () => {
    const view = normalizeLiveWork(project(), context());
    expect(view).toMatchObject({
      kind: "plan",
      projectName: "Northstar",
      planDisplay: "Plan 1/3",
      currentStep: "Inspect the safe projection",
      progressNow: 1,
      progressMax: 3,
    });
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("opaque-project-id");
    expect(rendered).not.toContain("opaque-plan-id");
    expect(rendered).not.toContain("step-secret");
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
    expect(view.details?.provenanceStatus).toBe("Stale");
  });

  it("redacts human text and does not cross-match another agent's main session", async () => {
    const unsafe = context();
    unsafe.capsule.content.summary =
      "Use /private/repo/file.ts then pnpm test SECRET_TOKEN=sk-1234567890abcdef";
    const view = normalizeLiveWork(project(), unsafe);
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("/private/repo/file.ts");
    expect(rendered).not.toContain("pnpm test");
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
});
