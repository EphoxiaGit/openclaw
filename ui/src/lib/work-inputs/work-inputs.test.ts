import { describe, expect, it, vi } from "vitest";
import { createWorkInputCapability } from "./index.ts";

describe("Work input capability", () => {
  it("reconciles durable state after targeted events", async () => {
    let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const request = vi.fn(async () => ({ requests: [] }));
    const client = { request } as never;
    const capability = createWorkInputCapability({
      snapshot: { connected: true, client },
      subscribeEvents: (listener) => {
        eventListener = listener;
        return () => undefined;
      },
    });
    await capability.refresh("agent:main:main");
    eventListener?.({
      event: "work.input.requested",
      payload: { request: { sessionKey: "agent:main:main" } },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("work.inputs.list", {
      sessionKey: "agent:main:main",
      status: "pending",
    });
    capability.dispose();
  });

  it("keeps requests isolated for every open chat session", async () => {
    const request = vi.fn(async (_method: string, params: { sessionKey: string }) => ({
      requests: [
        {
          id: `request:${params.sessionKey}`,
          revision: 1,
          status: "pending",
          sessionKey: params.sessionKey,
          createdAt: 1,
          updatedAt: 1,
          prompt: params.sessionKey,
          creator: { type: "system", label: "TaskFlow" },
          kind: "approval",
          decisions: ["approve", "reject"],
        },
      ],
    }));
    const capability = createWorkInputCapability({
      snapshot: { connected: true, client: { request } as never },
      subscribeEvents: () => () => undefined,
    });

    await Promise.all([capability.refresh("session-a"), capability.refresh("session-b")]);

    expect(capability.forSession("session-a").requests[0]?.sessionKey).toBe("session-a");
    expect(capability.forSession("session-b").requests[0]?.sessionKey).toBe("session-b");
    capability.dispose();
  });
});
