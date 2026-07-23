import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import {
  createCompanionIntegration,
  resolveCompanionMainBinding,
  type CompanionNativeChat,
} from "./companion-integration.js";

function chatEvent(input: Record<string, unknown>): ChatEvent {
  return input as ChatEvent;
}

function nativeChat(
  history: CompanionNativeChat["history"] = async () => ({ messages: [] }),
): CompanionNativeChat {
  return {
    history: vi.fn(history),
    abort: vi.fn(async () => ({ aborted: true })),
  };
}

function started(runId: string, sessionKey = "agent:main:main") {
  return {
    status: "started" as const,
    runId,
    sessionKey,
    agentId: "main",
  };
}

describe("companion integration", () => {
  it("resolves the fixed Main binding from server configuration", () => {
    expect(
      resolveCompanionMainBinding({
        conversationId: "companion-opaque",
        cfg: {
          session: { mainKey: "designated" },
          agents: { list: [{ id: "main" }, { id: "worker" }] },
        },
      }),
    ).toEqual({
      conversationId: "companion-opaque",
      sessionKey: "agent:main:designated",
      agentId: "main",
    });

    expect(
      resolveCompanionMainBinding({
        conversationId: "companion-global",
        cfg: {
          session: { scope: "global", mainKey: "ignored" },
          agents: { list: [{ id: "main" }] },
        },
      }),
    ).toEqual({
      conversationId: "companion-global",
      sessionKey: "global",
      agentId: "main",
    });
  });

  it("requires an explicitly configured Main agent", () => {
    expect(() =>
      resolveCompanionMainBinding({
        conversationId: "companion-opaque",
      }),
    ).toThrow("companion_main_agent_not_configured");
    expect(() =>
      resolveCompanionMainBinding({
        conversationId: "companion-opaque",
        cfg: { agents: { list: [{ id: "worker" }] } },
      }),
    ).toThrow("companion_main_agent_not_configured");
  });

  it("has no live hooks or buffering before an authorized recipient attaches", async () => {
    const authority = nativeChat();
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: authority,
    });

    expect(subject.onChatSendStarted(started("run-off"))).toBe(false);
    expect(
      subject.onChatEvent(
        chatEvent({
          runId: "run-off",
          sessionKey: "agent:main:main",
          seq: 0,
          state: "delta",
          deltaText: "not buffered",
        }),
      ),
    ).toBe(0);
    expect(await subject.cancelCurrent("missing")).toBe(false);
    expect(authority.history).not.toHaveBeenCalled();
    expect(authority.abort).not.toHaveBeenCalled();
  });

  it("allows exactly one recipient and recovers only native bounded presentation state", async () => {
    const authority = nativeChat(async () => ({
      messages: [
        { role: "user", content: "private prompt" },
        { role: "assistant", content: [{ type: "text", text: "Recovered reply" }] },
      ],
    }));
    const delivered: unknown[] = [];
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: authority,
    });

    expect(
      await subject.attachAuthorizedRecipient({
        connId: "authorized-1",
        publish: (event) => delivered.push(event),
      }),
    ).toBe(true);
    expect(
      await subject.attachAuthorizedRecipient({ connId: "authorized-2", publish: vi.fn() }),
    ).toBe(false);
    expect(delivered).toEqual([
      expect.objectContaining({ type: "assistant-text", text: "Recovered reply" }),
      expect.objectContaining({ type: "state", phase: "complete" }),
    ]);
    const wire = JSON.stringify({ bootstrap: subject.bootstrap(), delivered });
    expect(wire).not.toContain("agent:main:main");
    expect(wire).not.toContain("private prompt");
    expect(wire).not.toContain("runId");
  });

  it("drops detached events and re-converges from native in-flight history", async () => {
    const history = vi
      .fn<CompanionNativeChat["history"]>()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [],
        inFlightRun: { runId: "run-recovered", text: "Native partial" },
      });
    const first: unknown[] = [];
    const second: unknown[] = [];
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: nativeChat(history),
    });

    await subject.attachAuthorizedRecipient({
      connId: "authorized-1",
      publish: (event) => first.push(event),
    });
    expect(subject.detachRecipient("authorized-1")).toBe(true);
    expect(subject.onChatSendStarted(started("run-detached"))).toBe(false);
    expect(
      subject.onChatEvent(
        chatEvent({
          runId: "run-detached",
          sessionKey: "agent:main:main",
          seq: 0,
          state: "delta",
          deltaText: "must be dropped",
        }),
      ),
    ).toBe(0);

    await subject.attachAuthorizedRecipient({
      connId: "authorized-2",
      publish: (event) => second.push(event),
    });
    expect(history).toHaveBeenCalledTimes(2);
    expect(second).toEqual([
      expect.objectContaining({ type: "state", phase: "assistant-streaming" }),
      expect.objectContaining({ type: "assistant-text", text: "Native partial" }),
      expect.objectContaining({
        type: "semantic-command",
        command: { type: "set", state: "activity.thinking" },
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain("must be dropped");
    expect(JSON.stringify(second)).not.toContain("must be dropped");
  });

  it("delivers sanitized semantic activity only for the fixed binding and active run", async () => {
    const delivered: unknown[] = [];
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: nativeChat(),
    });
    await subject.attachAuthorizedRecipient({
      connId: "authorized",
      publish: (event) => delivered.push(event),
    });
    expect(subject.onChatSendStarted(started("run-current"))).toBe(true);
    expect(delivered).toContainEqual(
      expect.objectContaining({
        type: "semantic-command",
        command: { type: "set", state: "activity.thinking" },
      }),
    );
    expect(
      subject.onActivity({
        sessionKey: "agent:other:main",
        agentId: "main",
        runId: "run-current",
        source: "approval",
        sourceSequence: 1,
        activity: "waiting-user",
        observedAtMs: Date.now(),
      }),
    ).toBe(false);
    expect(
      subject.onActivity({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-current",
        source: "approval",
        sourceSequence: 1,
        activity: "waiting-user",
        observedAtMs: Date.now(),
      }),
    ).toBe(true);
    const semantic = delivered.at(-1);
    expect(semantic).toEqual(
      expect.objectContaining({
        type: "semantic-command",
        command: { type: "set", state: "conversation.waiting" },
      }),
    );
    expect(JSON.stringify(semantic)).not.toMatch(/sessionKey|runId|agentId|provider|tool|private/);
    expect(subject.detachRecipient("authorized")).toBe(true);
  });

  it("delegates cancellation once and waits for authoritative terminal evidence", async () => {
    const authority = nativeChat(async () => ({
      messages: [],
      inFlightRun: { runId: "run-current", text: "Partial" },
    }));
    const delivered: unknown[] = [];
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: authority,
    });
    await subject.attachAuthorizedRecipient({
      connId: "authorized",
      publish: (event) => delivered.push(event),
    });

    expect(await subject.cancelCurrent("other")).toBe(false);
    expect(await subject.cancelCurrent("authorized")).toBe(true);
    expect(await subject.cancelCurrent("authorized")).toBe(false);
    expect(authority.abort).toHaveBeenCalledTimes(1);
    expect(authority.abort).toHaveBeenCalledWith(
      {
        conversationId: "companion-opaque",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
      "run-current",
    );

    expect(
      subject.onChatEvent(
        chatEvent({
          runId: "run-current",
          sessionKey: "agent:main:main",
          seq: 1,
          state: "aborted",
          stopReason: "rpc",
        }),
      ),
    ).toBe(1);
    expect(await subject.cancelCurrent("authorized")).toBe(false);
    expect(delivered).toContainEqual(expect.objectContaining({ phase: "cancelled" }));
    expect(delivered.at(-1)).toEqual(
      expect.objectContaining({ type: "semantic-command", command: { type: "clear" } }),
    );
  });

  it("projects normalized completion and error outcomes without raw terminal details", async () => {
    for (const [state, semanticState] of [
      ["final", "activity.completed"],
      ["error", "activity.error"],
    ] as const) {
      const delivered: unknown[] = [];
      const subject = createCompanionIntegration({
        conversationId: "companion-opaque",
        cfg: { agents: { list: [{ id: "main" }] } },
        nativeChat: nativeChat(),
      });
      await subject.attachAuthorizedRecipient({
        connId: `authorized-${state}`,
        publish: (event) => delivered.push(event),
      });
      expect(subject.onChatSendStarted(started(`run-${state}`))).toBe(true);
      expect(
        subject.onChatEvent(
          chatEvent({
            runId: `run-${state}`,
            sessionKey: "agent:main:main",
            agentId: "main",
            seq: 0,
            state,
            errorMessage: "private terminal detail",
          }),
        ),
      ).toBe(1);
      expect(delivered.at(-1)).toEqual(
        expect.objectContaining({
          type: "semantic-command",
          command: { type: "set", state: semanticState },
        }),
      );
      expect(JSON.stringify(delivered)).not.toContain("private terminal detail");
      subject.detachRecipient(`authorized-${state}`);
    }
  });

  it("seeds thinking semantics for recovered in-flight runs with and without text", async () => {
    for (const text of ["Partial", ""]) {
      const delivered: unknown[] = [];
      const subject = createCompanionIntegration({
        conversationId: "companion-opaque",
        cfg: { agents: { list: [{ id: "main" }] } },
        nativeChat: nativeChat(async () => ({
          messages: [],
          inFlightRun: { runId: `run-${text || "empty"}`, text },
        })),
      });
      await subject.attachAuthorizedRecipient({
        connId: `authorized-${text || "empty"}`,
        publish: (event) => delivered.push(event),
      });
      expect(delivered.at(-1)).toEqual(
        expect.objectContaining({
          type: "semantic-command",
          command: { type: "set", state: "activity.thinking" },
        }),
      );
      subject.detachRecipient(`authorized-${text || "empty"}`);
    }
  });

  it("rejects foreign starts and lifecycle events before native authority is invoked", async () => {
    const authority = nativeChat();
    const delivered: unknown[] = [];
    const subject = createCompanionIntegration({
      conversationId: "companion-opaque",
      cfg: { agents: { list: [{ id: "main" }] } },
      nativeChat: authority,
    });
    await subject.attachAuthorizedRecipient({
      connId: "authorized",
      publish: (event) => delivered.push(event),
    });

    expect(subject.onChatSendStarted(started("run-foreign", "agent:other:main"))).toBe(false);
    expect(
      subject.onChatEvent(
        chatEvent({
          runId: "run-foreign",
          sessionKey: "agent:other:main",
          agentId: "other",
          seq: 0,
          state: "error",
          errorMessage: "private failure",
        }),
      ),
    ).toBe(0);
    expect(await subject.cancelCurrent("authorized")).toBe(false);
    expect(authority.abort).not.toHaveBeenCalled();
    expect(JSON.stringify(delivered)).not.toContain("private failure");
  });
});
