import { describe, expect, it } from "vitest";
import {
  COMPANION_CHAT_EVENT_SOURCE,
  COMPANION_BRIDGE_PROTOCOL,
  COMPANION_RUN_START_SOURCE,
  MAX_COMPANION_TRANSCRIPT_CHARS,
  createCompanionBridge,
  createCompanionBridgeDelivery,
} from "./companion-bridge.js";

function bridge() {
  return createCompanionBridge({
    conversationId: "companion-conversation-opaque",
    sessionKey: "agent:main:main",
    agentId: "main",
  });
}

function runStart(runId: string) {
  return {
    source: COMPANION_RUN_START_SOURCE,
    status: "started" as const,
    runId,
    sessionKey: "agent:main:main",
    agentId: "main",
  };
}

function lifecycleEvent(input: Record<string, unknown>) {
  return { source: COMPANION_CHAT_EVENT_SOURCE, ...input };
}

describe("companion bridge", () => {
  it("keeps server session and agent bindings out of browser bootstrap", () => {
    const bootstrap = bridge().bootstrap();
    expect(bootstrap).toEqual({
      protocol: COMPANION_BRIDGE_PROTOCOL,
      conversationId: "companion-conversation-opaque",
      phase: "idle",
    });
    expect(JSON.stringify(bootstrap)).not.toContain("agent:main:main");
    expect(JSON.stringify(bootstrap)).not.toContain('"main"');
  });

  it("accepts only a fixed Main binding and authorized started runs", () => {
    expect(() =>
      createCompanionBridge({
        conversationId: "companion-conversation-opaque",
        sessionKey: "agent:worker:main",
        agentId: "worker",
      }),
    ).toThrow("invalid_companion_main_agent");

    const subject = bridge();
    expect(
      subject.beginRun({ ...runStart("run-source"), source: "untrusted" } as never),
    ).toBeNull();
    expect(subject.beginRun({ ...runStart("run-status"), status: "pending" } as never)).toBeNull();
    expect(subject.beginRun(runStart("run-authorized"))).toMatchObject({ phase: "thinking" });
  });

  it("accepts only authoritative lifecycle events for an authorized run", () => {
    const subject = bridge();
    subject.beginRun(runStart("run-authoritative"));
    const event = lifecycleEvent({
      runId: "run-authoritative",
      sessionKey: "agent:main:main",
      agentId: "main",
      seq: 0,
      state: "delta",
      deltaText: "Safe text",
    });

    expect(subject.projectChatEvent({ ...event, source: "global-chat-broadcast" })).toEqual([]);
    expect(subject.projectChatEvent(event)).toHaveLength(2);
  });

  it("projects one fixed-agent run through thinking, streaming text, and completion", () => {
    const subject = bridge();
    expect(subject.beginRun(runStart("run-1"))).toMatchObject({
      type: "state",
      phase: "thinking",
      sequence: 1,
    });

    expect(
      subject.projectChatEvent(
        lifecycleEvent({
          runId: "run-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 0,
          state: "delta",
          deltaText: "Hello",
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "state", phase: "assistant-streaming", sequence: 2 }),
      expect.objectContaining({
        type: "assistant-text",
        mode: "append",
        text: "Hello",
        sequence: 3,
      }),
    ]);

    expect(
      subject.projectChatEvent(
        lifecycleEvent({
          runId: "run-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 1,
          state: "final",
        }),
      ),
    ).toEqual([expect.objectContaining({ type: "state", phase: "complete", sequence: 4 })]);
    expect(
      subject.projectChatEvent(
        lifecycleEvent({
          runId: "run-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 2,
          state: "delta",
          deltaText: "stale",
        }),
      ),
    ).toEqual([]);
  });

  it("uses the terminal assistant snapshot only when no delta was available", () => {
    const subject = bridge();
    subject.beginRun(runStart("run-2"));
    expect(
      subject.projectChatEvent(
        lifecycleEvent({
          runId: "run-2",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 0,
          state: "final",
          message: { content: [{ type: "text", text: "Complete reply" }] },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "assistant-text", mode: "replace", text: "Complete reply" }),
      expect.objectContaining({ type: "state", phase: "complete" }),
    ]);
  });

  it("rejects mismatched, missing-agent, replayed, and out-of-order source events", () => {
    const subject = bridge();
    subject.beginRun(runStart("run-3"));
    const valid = lifecycleEvent({
      runId: "run-3",
      sessionKey: "agent:main:main",
      agentId: "main",
      seq: 2,
      state: "delta" as const,
      deltaText: "first",
    });
    expect(subject.projectChatEvent({ ...valid, sessionKey: "agent:other:main" })).toEqual([]);
    expect(subject.projectChatEvent({ ...valid, agentId: undefined })).toEqual([]);
    expect(subject.projectChatEvent(valid)).toHaveLength(2);
    expect(subject.projectChatEvent(valid)).toEqual([]);
    expect(subject.projectChatEvent({ ...valid, seq: 1 })).toEqual([]);
  });

  it("redacts terminal details and bounds transcript data", () => {
    const subject = bridge();
    subject.beginRun(runStart("run-4"));
    const longText = "x".repeat(MAX_COMPANION_TRANSCRIPT_CHARS + 1);
    const events = subject.projectChatEvent(
      lifecycleEvent({
        runId: "run-4",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 0,
        state: "delta",
        deltaText: longText,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "assistant-text",
      text: "x".repeat(MAX_COMPANION_TRANSCRIPT_CHARS),
      truncated: true,
    });
    expect(
      subject.projectChatEvent(
        lifecycleEvent({
          runId: "run-4",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 1,
          state: "error",
          message: { content: "sensitive reply" },
        }),
      ),
    ).toEqual([expect.objectContaining({ type: "state", phase: "error" })]);
  });

  it("delivers only the fixed bridge projection through a server-owned publisher", () => {
    const delivered: unknown[] = [];
    const delivery = createCompanionBridgeDelivery({
      binding: {
        conversationId: "companion-conversation-opaque",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
      publish: (event) => delivered.push(event),
    });

    expect(delivery.bootstrap()).toEqual({
      protocol: COMPANION_BRIDGE_PROTOCOL,
      conversationId: "companion-conversation-opaque",
      phase: "idle",
    });
    expect(delivery.beginRun(runStart("run-delivery"))).toBe(true);
    expect(
      delivery.projectChatEvent(
        lifecycleEvent({
          runId: "run-delivery",
          sessionKey: "agent:main:main",
          agentId: "main",
          seq: 0,
          state: "delta",
          deltaText: "Safe text",
        }),
      ),
    ).toBe(2);
    expect(
      delivery.projectChatEvent(
        lifecycleEvent({
          runId: "run-delivery",
          sessionKey: "agent:other:main",
          agentId: "other",
          seq: 1,
          state: "error",
          message: { content: "raw private failure" },
        }),
      ),
    ).toBe(0);

    expect(delivered).toEqual([
      expect.objectContaining({ type: "state", phase: "thinking" }),
      expect.objectContaining({ type: "state", phase: "assistant-streaming" }),
      expect.objectContaining({ type: "assistant-text", text: "Safe text" }),
    ]);
    expect(JSON.stringify(delivered)).not.toContain("agent:main:main");
    expect(JSON.stringify(delivered)).not.toContain("raw private failure");
  });
});
