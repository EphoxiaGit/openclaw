import { describe, expect, it } from "vitest";
import {
  COMPANION_BRIDGE_PROTOCOL,
  MAX_COMPANION_TRANSCRIPT_CHARS,
  createCompanionBridge,
} from "./companion-bridge.js";

function bridge() {
  return createCompanionBridge({
    conversationId: "companion-conversation-opaque",
    sessionKey: "agent:main:main",
    agentId: "main",
  });
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

  it("projects one fixed-agent run through thinking, streaming text, and completion", () => {
    const subject = bridge();
    expect(
      subject.beginRun({ runId: "run-1", sessionKey: "agent:main:main", agentId: "main" }),
    ).toMatchObject({ type: "state", phase: "thinking", sequence: 1 });

    expect(
      subject.projectChatEvent({
        runId: "run-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 0,
        state: "delta",
        deltaText: "Hello",
      }),
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
      subject.projectChatEvent({
        runId: "run-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 1,
        state: "final",
      }),
    ).toEqual([expect.objectContaining({ type: "state", phase: "complete", sequence: 4 })]);
    expect(
      subject.projectChatEvent({
        runId: "run-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 2,
        state: "delta",
        deltaText: "stale",
      }),
    ).toEqual([]);
  });

  it("uses the terminal assistant snapshot only when no delta was available", () => {
    const subject = bridge();
    subject.beginRun({ runId: "run-2", sessionKey: "agent:main:main", agentId: "main" });
    expect(
      subject.projectChatEvent({
        runId: "run-2",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 0,
        state: "final",
        message: { content: [{ type: "text", text: "Complete reply" }] },
      }),
    ).toEqual([
      expect.objectContaining({ type: "assistant-text", mode: "replace", text: "Complete reply" }),
      expect.objectContaining({ type: "state", phase: "complete" }),
    ]);
  });

  it("rejects mismatched, missing-agent, replayed, and out-of-order source events", () => {
    const subject = bridge();
    subject.beginRun({ runId: "run-3", sessionKey: "agent:main:main", agentId: "main" });
    const valid = {
      runId: "run-3",
      sessionKey: "agent:main:main",
      agentId: "main",
      seq: 2,
      state: "delta" as const,
      deltaText: "first",
    };
    expect(subject.projectChatEvent({ ...valid, sessionKey: "agent:other:main" })).toEqual([]);
    expect(subject.projectChatEvent({ ...valid, agentId: undefined })).toEqual([]);
    expect(subject.projectChatEvent(valid)).toHaveLength(2);
    expect(subject.projectChatEvent(valid)).toEqual([]);
    expect(subject.projectChatEvent({ ...valid, seq: 1 })).toEqual([]);
  });

  it("redacts terminal details and bounds transcript data", () => {
    const subject = bridge();
    subject.beginRun({ runId: "run-4", sessionKey: "agent:main:main", agentId: "main" });
    const longText = "x".repeat(MAX_COMPANION_TRANSCRIPT_CHARS + 1);
    const events = subject.projectChatEvent({
      runId: "run-4",
      sessionKey: "agent:main:main",
      agentId: "main",
      seq: 0,
      state: "delta",
      deltaText: longText,
    });
    expect(events.at(-1)).toMatchObject({
      type: "assistant-text",
      text: "x".repeat(MAX_COMPANION_TRANSCRIPT_CHARS),
      truncated: true,
    });
    expect(
      subject.projectChatEvent({
        runId: "run-4",
        sessionKey: "agent:main:main",
        agentId: "main",
        seq: 1,
        state: "error",
        message: { content: "sensitive reply" },
      }),
    ).toEqual([expect.objectContaining({ type: "state", phase: "error" })]);
  });
});
