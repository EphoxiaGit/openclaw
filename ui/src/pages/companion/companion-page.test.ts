import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import {
  COMPANION_AIRI_STAGE_URL,
  COMPANION_LOCAL_STAGE_URL,
  readCompanionAttachResult,
  readCompanionEvent,
  readCompanionRendererSelection,
} from "../../app/companion-stage.ts";
import type { ApplicationContext } from "../../app/context.ts";
import "./companion-page.ts";

function createPage(
  localStageEnabled: boolean,
  context?: ApplicationContext,
  renderer: "minimal" | "airi" = "minimal",
) {
  const page = document.createElement("openclaw-companion-page") as HTMLElement & {
    routeData?: {
      localStageEnabled: boolean;
      selection: ReturnType<typeof readCompanionRendererSelection>;
    };
    updateComplete: Promise<unknown>;
  };
  if (context) {
    (page as unknown as { context?: ApplicationContext }).context = context;
  }
  page.routeData = {
    localStageEnabled,
    selection: readCompanionRendererSelection({
      gateway: { controlUi: { companionRenderer: renderer } },
    }),
  };
  document.body.append(page);
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Companion page", () => {
  it("sanitizes the fixed attach and event contracts before embodiment", () => {
    expect(
      readCompanionAttachResult({
        attached: true,
        protocol: "openclaw.companion.v1",
        conversationId: "opaque-conversation",
        phase: "idle",
        sessionKey: "private-session",
        agentId: "private-agent",
        runId: "private-run",
        token: "private-token",
      }),
    ).toEqual({
      attached: true,
      protocol: "openclaw.companion.v1",
      conversationId: "opaque-conversation",
      phase: "idle",
    });
    expect(
      readCompanionEvent({
        type: "state",
        conversationId: "opaque-conversation",
        sequence: 1,
        phase: "thinking",
        runId: "private-run",
        userPrompt: "private prompt",
      }),
    ).toEqual({
      type: "state",
      conversationId: "opaque-conversation",
      sequence: 1,
      phase: "thinking",
    });
    expect(
      readCompanionEvent({
        type: "assistant-text",
        conversationId: "opaque-conversation",
        sequence: 2,
        mode: "append",
        text: "x".repeat(4_001),
        truncated: false,
      }),
    ).toBeNull();
  });

  it("reserves a responsive upper stage and lower Main dock", async () => {
    const testPath = expect.getState().testPath;
    if (!testPath) throw new Error("companion_test_path_unavailable");
    const css = await readFile(
      path.resolve(path.dirname(testPath), "../../styles/companion.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.content:has\(openclaw-companion-page\)\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s,
    );
    expect(css).toMatch(
      /> openclaw-router-outlet\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*margin-top:\s*0;/s,
    );
    expect(css).toMatch(
      /\.companion-host\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 2fr\) minmax\(7rem, 1fr\);[^}]*height:\s*100%;[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /\.companion-host__stage\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /\.companion-host__frame\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.companion-host\s*\{[^}]*grid-template-rows:\s*minmax\(22rem, 62vh\) auto;[^}]*overflow:\s*auto;/s,
    );
  });

  it("keeps the renderer disabled until the local route gate is present", async () => {
    const page = createPage(false);
    await page.updateComplete;

    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Local Companion renderer is disabled.");
    page.remove();
  });

  it("embeds only the fixed local renderer with a restrictive iframe boundary", async () => {
    const port1 = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    };
    const port2 = {};
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = port1;
        port2 = port2;
      },
    );
    const page = createPage(true);
    await page.updateComplete;

    const frame = page.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe(COMPANION_LOCAL_STAGE_URL);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame?.getAttribute("allow")).toBe("autoplay");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(page.getAttribute("data-frame-state")).toBeNull();

    const postMessage = vi.spyOn(frame!.contentWindow!, "postMessage");
    frame?.dispatchEvent(new Event("load"));
    await page.updateComplete;
    expect(page.querySelector(".companion-host")?.getAttribute("data-frame-state")).toBe("ready");
    expect(postMessage).toHaveBeenCalledWith(
      { type: "openclaw-companion-channel", protocol: "openclaw.companion.v1" },
      "http://127.0.0.1:5184",
      [port2],
    );
    expect(port1.start).toHaveBeenCalledOnce();
    page.remove();
    expect(port1.close).toHaveBeenCalledOnce();
  });

  it("attaches once, projects events to the renderer, cancels, and detaches", async () => {
    let eventListener: ((event: GatewayEventFrame) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "companion.attach") {
        return {
          attached: true,
          protocol: "openclaw.companion.v1",
          conversationId: "opaque-conversation",
          phase: "idle",
        };
      }
      if (method === "companion.cancel") return { aborted: true };
      return { detached: true };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        connected: true,
        reconnecting: false,
        client,
        hello: {
          auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
          features: {
            methods: ["companion.attach", "companion.detach", "companion.cancel"],
          },
        },
        assistantAgentId: "main",
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe: vi.fn(() => () => undefined),
      subscribeEvents: vi.fn((listener: (event: GatewayEventFrame) => void) => {
        eventListener = listener;
        return () => undefined;
      }),
    };
    const navigate = vi.fn();
    let rendererMessageListener: ((event: MessageEvent<unknown>) => void) | undefined;
    const port1 = {
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) => {
        rendererMessageListener = listener;
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = port1;
        port2 = {};
      },
    );
    const page = createPage(true, { gateway, navigate } as unknown as ApplicationContext, "airi");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("companion.attach", {}));
    await page.updateComplete;
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(COMPANION_AIRI_STAGE_URL);
    eventListener?.({
      type: "event",
      event: "companion.event",
      payload: {
        type: "semantic-command",
        conversationId: "opaque-conversation",
        sequence: 1,
        command: { type: "set", state: "activity.searching" },
      },
    });
    frame?.dispatchEvent(new Event("load"));
    expect(port1.postMessage).toHaveBeenCalledWith({
      type: "set-companion-presentation",
      presentation: { model: "native", camera: "native", animation: "idle" },
      revision: 1,
    });
    expect(port1.postMessage).toHaveBeenCalledWith({
      type: "set-companion-semantic",
      command: { type: "set", state: "activity.searching" },
      revision: 1,
    });

    eventListener?.({
      type: "event",
      event: "companion.event",
      payload: {
        type: "state",
        conversationId: "opaque-conversation",
        sequence: 1,
        phase: "thinking",
      },
    });
    await page.updateComplete;
    expect(port1.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "set-companion-state", state: "thinking" }),
    );
    eventListener?.({
      type: "event",
      event: "companion.event",
      payload: {
        type: "semantic-command",
        conversationId: "opaque-conversation",
        sequence: 2,
        command: { type: "set", state: "activity.searching" },
      },
    });
    expect(port1.postMessage).toHaveBeenLastCalledWith({
      type: "set-companion-semantic",
      command: { type: "set", state: "activity.searching" },
      revision: 2,
    });

    const cancel = page.querySelector<HTMLButtonElement>(".companion-host__cancel");
    expect(cancel).not.toBeNull();
    expect(cancel?.closest(".companion-host__dock")).not.toBeNull();
    expect(page.querySelector(".companion-host__runtime-status")?.textContent).toContain(
      "Main · thinking",
    );
    cancel?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("companion.cancel", {}));

    page.querySelector<HTMLButtonElement>(".companion-host__chat")?.click();
    expect(navigate).toHaveBeenCalledWith("chat");

    rendererMessageListener?.({
      data: { type: "open-main-chat", sequence: 1 },
    } as MessageEvent<unknown>);
    expect(navigate).toHaveBeenCalledTimes(2);
    rendererMessageListener?.({
      data: { type: "cancel-response", sequence: 2 },
    } as MessageEvent<unknown>);
    rendererMessageListener?.({
      data: { type: "send-message", text: "must-not-cross", sequence: 3 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "companion.cancel")).toHaveLength(
        2,
      ),
    );

    page.remove();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("companion.detach", {}));
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port1.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
