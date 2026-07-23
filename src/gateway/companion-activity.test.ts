import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_ACTIVITIES,
  companionActivityCommand,
  createCompanionActivityPolicy,
  type CompanionActivityInput,
} from "./companion-activity.js";

const expectedCommands = [
  { type: "clear" },
  { type: "set", state: "attention.focus" },
  { type: "set", state: "conversation.listening" },
  { type: "set", state: "activity.thinking" },
  { type: "set", state: "activity.thinking" },
  { type: "set", state: "activity.thinking" },
  { type: "set", state: "activity.searching" },
  { type: "set", state: "attention.focus" },
  { type: "set", state: "activity.coding" },
  { type: "set", state: "activity.toolUse" },
  { type: "set", state: "activity.waitingForWorker" },
  { type: "set", state: "conversation.waiting" },
  { type: "set", state: "conversation.speaking" },
  { type: "set", state: "activity.completed" },
  { type: "set", state: "emotion.concerned" },
  { type: "set", state: "activity.error" },
  { type: "set", state: "emotion.sleepy" },
  { type: "set", state: "emotion.curious" },
];

describe("Companion activity policy", () => {
  it("maps every closed activity to the accepted semantic vocabulary", () => {
    expect(COMPANION_ACTIVITIES.map(companionActivityCommand)).toEqual(expectedCommands);
  });

  it("rejects wrong private bindings, stale inputs, coalesces chatter, leases priority, quiets, and disposes timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const publish = vi.fn();
    let runId: string | undefined = "run-1";
    const policy = createCompanionActivityPolicy({
      sessionKey: "private-main",
      agentId: "main",
      getRunId: () => runId,
      publish,
      quietMs: 1_000,
      debounceMs: 50,
    });
    const input = (overrides: Partial<CompanionActivityInput> = {}): CompanionActivityInput => ({
      sessionKey: "private-main",
      agentId: "main",
      runId: "run-1",
      source: "lifecycle",
      sourceSequence: 1,
      activity: "thinking",
      observedAtMs: Date.now(),
      ...overrides,
    });

    expect(policy.reduce(input({ sessionKey: "wrong" }))).toBe(false);
    expect(policy.reduce(input({ runId: "wrong" }))).toBe(false);
    expect(policy.reduce(input())).toBe(true);
    expect(policy.reduce(input({ sourceSequence: 1 }))).toBe(false);
    expect(policy.reduce(input({ sourceSequence: 2 }))).toBe(false);
    expect(policy.reduce(input({ source: "plan", sourceSequence: 1, activity: "planning" }))).toBe(
      false,
    );
    expect(publish).toHaveBeenCalledTimes(1);

    expect(
      policy.reduce(input({ source: "approval", sourceSequence: 1, activity: "waiting-user" })),
    ).toBe(true);
    expect(publish).toHaveBeenNthCalledWith(2, { type: "clear", domain: "activity" });
    expect(publish).toHaveBeenNthCalledWith(3, {
      type: "set",
      state: "conversation.waiting",
    });
    expect(policy.reduce(input({ source: "tool", sourceSequence: 1, activity: "tool-use" }))).toBe(
      false,
    );
    vi.advanceTimersByTime(699);
    expect(publish).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenNthCalledWith(4, { type: "clear", domain: "conversation" });
    expect(publish).toHaveBeenLastCalledWith({ type: "set", state: "activity.toolUse" });

    vi.advanceTimersByTime(1_000);
    expect(publish).toHaveBeenLastCalledWith({ type: "clear" });
    policy.dispose();
    runId = undefined;
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("validates runtime allowlists and repeated priority activity cancels pending work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const publish = vi.fn();
    const policy = createCompanionActivityPolicy({
      sessionKey: "private-main",
      agentId: "main",
      getRunId: () => "run-1",
      publish,
      quietMs: 2_000,
    });
    const base: CompanionActivityInput = {
      sessionKey: "private-main",
      agentId: "main",
      runId: "run-1",
      source: "approval",
      sourceSequence: 1,
      activity: "waiting-user",
      observedAtMs: Date.now(),
    };
    expect(policy.reduce({ ...base, source: "raw" as never })).toBe(false);
    expect(policy.reduce({ ...base, activity: "raw" as never })).toBe(false);
    expect(policy.reduce(base)).toBe(true);
    expect(
      policy.reduce({
        ...base,
        source: "tool",
        sourceSequence: 1,
        activity: "tool-use",
      }),
    ).toBe(false);
    expect(policy.reduce({ ...base, sourceSequence: 2 })).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith({
      type: "set",
      state: "conversation.waiting",
    });
    policy.dispose();
    vi.useRealTimers();
  });
});
