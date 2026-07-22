/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  computeFileSearchMatches,
  editorOpenUrl,
  nextWorkPlanDetailTab,
  renderMarkdownSidebar,
  splitHighlightedHtmlIntoLines,
} from "./chat-sidebar.ts";

describe("computeFileSearchMatches", () => {
  it("finds matching line numbers", () => {
    expect(computeFileSearchMatches("alpha\nbeta\ngamma", "beta")).toEqual([2]);
  });

  it("matches case-insensitively", () => {
    expect(computeFileSearchMatches("Alpha\nBETA", "alpha")).toEqual([1]);
  });

  it("returns no matches for an empty query", () => {
    expect(computeFileSearchMatches("alpha\nbeta", "")).toEqual([]);
  });

  it("returns every matching line once", () => {
    expect(computeFileSearchMatches("match match\nnope\nMATCH", "match")).toEqual([1, 3]);
  });
});

describe("editorOpenUrl", () => {
  it("creates a custom editor URL for a plain path", () => {
    expect(editorOpenUrl("cursor", "/workspace/src/foo.ts")).toBe(
      "cursor://file/workspace/src/foo.ts",
    );
  });

  it("encodes spaces in paths", () => {
    expect(editorOpenUrl("vscode", "/workspace/My File.ts")).toBe(
      "vscode://file/workspace/My%20File.ts",
    );
  });

  it("appends a target line", () => {
    expect(editorOpenUrl("zed", "/workspace/src/foo.ts", 42)).toBe(
      "zed://file/workspace/src/foo.ts:42",
    );
  });

  it("normalizes Windows paths", () => {
    expect(editorOpenUrl("vscode", "C:\\workspace\\src\\foo.ts", 42)).toBe(
      "vscode://file/C:/workspace/src/foo.ts:42",
    );
  });

  it("encodes URL-significant path characters", () => {
    expect(editorOpenUrl("windsurf", "/workspace/#notes?.md")).toBe(
      "windsurf://file/workspace/%23notes%3F.md",
    );
  });
});

describe("splitHighlightedHtmlIntoLines", () => {
  it("closes and reopens highlighted spans across lines", () => {
    expect(splitHighlightedHtmlIntoLines('<span class="hljs-keyword">const\nlet</span>')).toEqual([
      '<span class="hljs-keyword">const</span>',
      '<span class="hljs-keyword">let</span>',
    ]);
  });

  it("passes plain highlighted text through line by line", () => {
    expect(splitHighlightedHtmlIntoLines("first\nsecond")).toEqual(["first", "second"]);
  });
});

describe("file sidebar", () => {
  it("renders line-number gutters and marks the requested line", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "file",
          path: "src/lib/foo.ts",
          name: "foo.ts",
          content: "const first = 1;\nconst second = 2;",
          language: "ts",
          line: 2,
          rawText: "const first = 1;\nconst second = 2;",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const lines = container.querySelectorAll<HTMLElement>(".file-view__line");
    expect(lines).toHaveLength(2);
    expect([...lines].map((line) => line.dataset.line)).toEqual(["1", "2"]);
    expect(container.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe(
      "2",
    );
    expect(container.querySelector(".sidebar-file-view__path")?.textContent).toBe("src/lib/foo.ts");
  });
});

describe("markdown sidebar", () => {
  it("renders workspace file links in markdown previews", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "markdown",
          content: "See ui/src/components/markdown.ts:1146",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe("ui/src/components/markdown.ts");
    expect(link?.dataset.fileLine).toBe("1146");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("opens workspace files from markdown preview clicks", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenWorkspaceFile = vi.fn();
    panel.content = {
      kind: "markdown",
      content: "See `ui/src/pages/chat/chat-view.ts:362`",
    };
    panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLAnchorElement>("a.markdown-file-link")?.click();

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
      path: "ui/src/pages/chat/chat-view.ts",
      line: 362,
    });
    panel.remove();
  });

  it("isolates one mobile chat pane and restores the exact detail opener", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(max-width: 768px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const otherPaneButton = document.createElement("button");
    const pane = document.createElement("openclaw-chat-pane");
    const rail = document.createElement("aside");
    const split = document.createElement("div");
    const main = document.createElement("div");
    const divider = document.createElement("resizable-divider");
    const opener = document.createElement("button");
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      activePane: boolean;
      updateComplete?: Promise<unknown>;
    };
    rail.className = "chat-workspace-rail";
    split.className = "chat-split-container";
    main.className = "chat-main";
    opener.textContent = "Open details";
    panel.content = { kind: "markdown", content: "Safe details" };
    panel.activePane = true;
    main.append(opener);
    split.append(main, divider);
    pane.append(rail, split);
    document.body.append(otherPaneButton, pane);
    opener.focus();
    split.append(panel);
    panel.addEventListener("chat-detail-panel-close", () => panel.remove());
    await panel.updateComplete;

    expect(main.inert).toBe(true);
    expect(divider.inert).toBe(true);
    expect(rail.inert).toBe(true);
    expect(otherPaneButton.inert).not.toBe(true);

    panel.querySelector<HTMLButtonElement>(".sidebar-header button")?.click();
    await Promise.resolve();

    expect(document.activeElement).toBe(opener);
    expect(main.inert).not.toBe(true);
    expect(divider.inert).not.toBe(true);
    expect(rail.inert).not.toBe(true);
    expect(main.hasAttribute("aria-hidden")).toBe(false);

    pane.remove();
    otherPaneButton.remove();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });
});

describe("work plan sidebar", () => {
  it("renders an instance-scoped, keyboard-navigable plan tab without invented evidence", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "work-plan",
          title: "Northstar work details",
          projectName: "Northstar",
          planPosition: { x: 1, n: 3 },
          planStatus: "review",
          summary: "Bounded work.",
          focus: "Review",
          capsuleCounts: { constraints: 1, decisions: 2, openQuestions: 3, conflicts: 0 },
          provenanceStatus: "unavailable",
          objective: "Ship the slice",
          activeSteps: [],
          readySteps: ["Review the slice"],
          blockedSteps: [],
          evidenceCount: 4,
          orderedSteps: [
            { title: "Review the slice", ordinal: 1, status: "review", dependencies: [] },
          ],
          requirements: { mapped: ["Keep chat authoritative"], excluded: [], unresolved: [] },
          revisions: { project: 5, plan: 6, goal: 7, capsule: 8 },
          checkpointPresent: true,
          nextTask: "Review the slice",
          nextTaskSource: "ready-step",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
        workPlanIdPrefix: "pane-a-work",
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Plan 1/3");
    expect(text).toContain("In review");
    expect(text).toContain("Ordered steps");
    expect(text).toContain("Review the slice");
    expect(text).not.toContain("Plan evidence");
    expect(container.querySelector('[role="tab"]')?.id).toBe("pane-a-work-tab-plan");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(
      "pane-a-work-tab-plan",
    );
    expect(nextWorkPlanDetailTab("plan", "ArrowRight")).toBe("agents");
    expect(nextWorkPlanDetailTab("plan", "ArrowLeft")).toBe("evidence");
    expect(nextWorkPlanDetailTab("context", "Home")).toBe("plan");
    expect(nextWorkPlanDetailTab("context", "End")).toBe("evidence");
  });

  it("renders observed worker state in the Agents tab", () => {
    const container = document.createElement("div");
    const onCancelWorker = vi.fn();
    render(
      renderMarkdownSidebar({
        content: {
          kind: "work-plan",
          title: "Northstar work details",
          projectName: "Northstar",
          planPosition: { x: 1, n: 3 },
          planStatus: "running",
          summary: "Bounded work.",
          focus: "Implementation",
          capsuleCounts: { constraints: 0, decisions: 0, openQuestions: 0, conflicts: 0 },
          provenanceStatus: "current",
          objective: "Ship the slice",
          activeSteps: ["Implement the slice"],
          readySteps: [],
          blockedSteps: [],
          workers: [
            {
              actionKey: "worker-1-1",
              label: "Research worker",
              parentLabel: "Main assistant",
              ownerKind: "isolated",
              role: "Researcher",
              lane: "subagent",
              state: "running",
              health: "busy",
              provider: "openai",
              model: "gpt-5.6-terra",
              runtime: "codex",
              progress: "Comparing existing implementation seams.",
              result: "",
              contextPercent: 42,
              elapsedMs: 1250,
              canCancel: true,
            },
          ],
          evidenceCount: 0,
          revisions: { project: 1, plan: 1, goal: 1, capsule: 1 },
          checkpointPresent: false,
          nextTask: "Implement the slice",
          nextTaskSource: "ready-step",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
        onCancelWorkPlanWorker: onCancelWorker,
        workPlanTab: "agents",
        workPlanIdPrefix: "pane-agents-work",
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Research worker");
    expect(text).toContain("Researcher");
    expect(text).toContain("Isolated");
    expect(text).toContain("subagent");
    expect(text).toContain("Busy");
    expect(text).toContain("openai");
    expect(text).toContain("gpt-5.6-terra");
    expect(text).toContain("42%");
    container.querySelector<HTMLButtonElement>('[aria-label="Cancel Research worker"]')?.click();
    expect(onCancelWorker).toHaveBeenCalledWith("worker-1-1");
  });
});
