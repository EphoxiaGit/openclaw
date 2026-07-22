/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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

    await config.refresh();

    expect(config.current.workspaceLiveWorkVisible).toBe(true);
    expect(config.current.workspaceLiveWorkShowContinueDraft).toBe(true);
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
  });
});
