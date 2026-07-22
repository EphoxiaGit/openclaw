/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createLiveWorkState, refreshLiveWork } from "../pages/chat/components/chat-live-work.ts";
import { createApplicationConfigCapability } from "./config.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("application config workspace bootstrap", () => {
  it("keeps both native live-work presentation defaults enabled when absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              basePath: "",
              assistantName: "Assistant",
              assistantAvatar: "",
              assistantAgentId: "main",
              terminalEnabled: false,
            }),
            { status: 200 },
          ),
      ),
    );
    const config = createApplicationConfigCapability({ basePath: "" });
    expect(config.current.workspaceLiveWorkSettled).toBe(false);

    await config.refresh();

    expect(config.current.workspaceLiveWorkVisible).toBe(true);
    expect(config.current.workspaceLiveWorkShowContinueDraft).toBe(true);
    expect(config.current.workspaceLiveWorkSettled).toBe(true);
  });

  it("consumes the gateway-resolved disabled presentation flags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              basePath: "",
              assistantName: "Assistant",
              assistantAvatar: "",
              assistantAgentId: "main",
              terminalEnabled: false,
              workspaceLiveWorkVisible: false,
              workspaceLiveWorkShowContinueDraft: false,
            }),
            { status: 200 },
          ),
      ),
    );
    const config = createApplicationConfigCapability({ basePath: "" });

    await config.refresh();

    expect(config.current.workspaceLiveWorkVisible).toBe(false);
    expect(config.current.workspaceLiveWorkShowContinueDraft).toBe(false);
    expect(config.current.workspaceLiveWorkSettled).toBe(true);
  });

  it("settles to the safe visible defaults after an attempted bootstrap failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const config = createApplicationConfigCapability({ basePath: "" });

    await config.refresh({ auth: { settings: { token: "current-token" } } });

    expect(config.current.workspaceLiveWorkSettled).toBe(true);
    expect(config.current.workspaceLiveWorkVisible).toBe(true);
    expect(config.current.workspaceLiveWorkShowContinueDraft).toBe(true);
  });

  it("does not settle an optimistic cold-start refresh that fails authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const config = createApplicationConfigCapability({ basePath: "" });

    await config.refresh({
      auth: { settings: { token: "stale-startup-token" } },
      skipWithoutAuthCandidate: true,
    });

    expect(config.current.workspaceLiveWorkSettled).toBe(false);
  });

  it("makes no projection requests before persisted hidden config settles", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const config = createApplicationConfigCapability({ basePath: "" });
    const request = vi.fn();
    const state = createLiveWorkState();
    const client = { request } as unknown as GatewayBrowserClient;
    const refresh = config.refresh({ auth: { settings: { token: "current-token" } } });

    await refreshLiveWork(
      state,
      client,
      "agent:main:main",
      true,
      () => undefined,
      config.current.workspaceLiveWorkSettled && config.current.workspaceLiveWorkVisible,
    );
    expect(request).not.toHaveBeenCalled();

    resolveFetch(
      new Response(
        JSON.stringify({
          basePath: "",
          assistantName: "Assistant",
          assistantAvatar: "",
          assistantAgentId: "main",
          terminalEnabled: false,
          workspaceLiveWorkVisible: false,
          workspaceLiveWorkShowContinueDraft: true,
        }),
        { status: 200 },
      ),
    );
    await refresh;
    await refreshLiveWork(
      state,
      client,
      "agent:main:main",
      true,
      () => undefined,
      config.current.workspaceLiveWorkSettled && config.current.workspaceLiveWorkVisible,
    );

    expect(config.current.workspaceLiveWorkSettled).toBe(true);
    expect(config.current.workspaceLiveWorkVisible).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
