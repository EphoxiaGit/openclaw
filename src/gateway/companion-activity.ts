import type { CompanionSemanticCommand } from "../../packages/gateway-protocol/src/index.js";

export const COMPANION_ACTIVITIES = [
  "idle",
  "user-detected",
  "listening",
  "transcribing",
  "thinking",
  "planning",
  "searching",
  "reading",
  "coding",
  "tool-use",
  "waiting-worker",
  "waiting-user",
  "speaking",
  "completed",
  "warning",
  "error",
  "sleeping",
  "reflection",
] as const;

export type CompanionActivity = (typeof COMPANION_ACTIVITIES)[number];
export type CompanionActivitySource =
  | "lifecycle"
  | "thinking"
  | "plan"
  | "item"
  | "tool"
  | "approval"
  | "patch"
  | "command-output"
  | "chat-outcome"
  | "voice";

export type CompanionActivityInput = Readonly<{
  sessionKey: string;
  agentId: string;
  runId: string;
  source: CompanionActivitySource;
  sourceSequence: number;
  activity: CompanionActivity;
  observedAtMs: number;
}>;

export type CompanionActivityPolicy = Readonly<{
  reduce: (input: CompanionActivityInput) => boolean;
  force: (input: CompanionActivityInput) => boolean;
  dispose: () => void;
}>;

const ACTIVITY_ALLOWLIST = new Set<string>(COMPANION_ACTIVITIES);
const SOURCE_ALLOWLIST = new Set<string>([
  "lifecycle",
  "thinking",
  "plan",
  "item",
  "tool",
  "approval",
  "patch",
  "command-output",
  "chat-outcome",
  "voice",
] satisfies readonly CompanionActivitySource[]);

const COMMANDS: Record<CompanionActivity, CompanionSemanticCommand> = {
  idle: { type: "clear" },
  "user-detected": { type: "set", state: "attention.focus" },
  listening: { type: "set", state: "conversation.listening" },
  transcribing: { type: "set", state: "activity.thinking" },
  thinking: { type: "set", state: "activity.thinking" },
  planning: { type: "set", state: "activity.thinking" },
  searching: { type: "set", state: "activity.searching" },
  reading: { type: "set", state: "attention.focus" },
  coding: { type: "set", state: "activity.coding" },
  "tool-use": { type: "set", state: "activity.toolUse" },
  "waiting-worker": { type: "set", state: "activity.waitingForWorker" },
  "waiting-user": { type: "set", state: "conversation.waiting" },
  speaking: { type: "set", state: "conversation.speaking" },
  completed: { type: "set", state: "activity.completed" },
  warning: { type: "set", state: "emotion.concerned" },
  error: { type: "set", state: "activity.error" },
  sleeping: { type: "set", state: "emotion.sleepy" },
  reflection: { type: "set", state: "emotion.curious" },
};

const PRIORITY: Record<CompanionActivity, number> = {
  idle: 0,
  sleeping: 1,
  completed: 2,
  reflection: 3,
  thinking: 4,
  planning: 4,
  transcribing: 4,
  reading: 5,
  searching: 5,
  coding: 5,
  "tool-use": 5,
  "waiting-worker": 5,
  "user-detected": 6,
  listening: 6,
  "waiting-user": 7,
  speaking: 8,
  warning: 9,
  error: 10,
};

const LEASE_MS: Record<CompanionActivity, number> = {
  idle: 0,
  "user-detected": 300,
  listening: 500,
  transcribing: 400,
  thinking: 350,
  planning: 500,
  searching: 500,
  reading: 400,
  coding: 500,
  "tool-use": 500,
  "waiting-worker": 500,
  "waiting-user": 700,
  speaking: 700,
  completed: 1_200,
  warning: 1_200,
  error: 1_500,
  sleeping: 1_000,
  reflection: 700,
};

export function companionActivityCommand(activity: CompanionActivity): CompanionSemanticCommand {
  return COMMANDS[activity];
}

function commandDomain(command: CompanionSemanticCommand): string | undefined {
  return command.type === "set" ? command.state.split(".", 1)[0] : command.domain;
}

function commandsEqual(left: CompanionSemanticCommand, right: CompanionSemanticCommand): boolean {
  return (
    left.type === right.type &&
    (left.type === "set"
      ? right.type === "set" && left.state === right.state
      : right.type === "clear" && left.domain === right.domain)
  );
}

/**
 * Reduces private run activity to a bounded semantic presentation stream. Two
 * timers are the maximum: one deferred transition and one quiet reset.
 */
export function createCompanionActivityPolicy(params: {
  sessionKey: string;
  agentId: string;
  getRunId: () => string | undefined;
  publish: (command: CompanionSemanticCommand) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  debounceMs?: number;
  quietMs?: number;
}): CompanionActivityPolicy {
  const now = params.now ?? Date.now;
  const setTimer = params.setTimer ?? setTimeout;
  const clearTimer = params.clearTimer ?? clearTimeout;
  const debounceMs = params.debounceMs ?? 80;
  const quietMs = params.quietMs ?? 4_000;
  const lastSequence = new Map<CompanionActivitySource, number>();
  let current: CompanionActivity = "idle";
  let leaseUntil = 0;
  let pending: CompanionActivity | undefined;
  let transitionTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelTransition = () => {
    if (transitionTimer !== undefined) clearTimer(transitionTimer);
    transitionTimer = undefined;
    pending = undefined;
  };
  const scheduleQuiet = () => {
    if (quietTimer !== undefined) clearTimer(quietTimer);
    quietTimer = setTimer(() => {
      quietTimer = undefined;
      if (!disposed && current !== "idle") {
        cancelTransition();
        current = "idle";
        leaseUntil = 0;
        params.publish(COMMANDS.idle);
      }
    }, quietMs);
  };
  const apply = (activity: CompanionActivity, at: number) => {
    cancelTransition();
    if (activity === current) {
      leaseUntil = Math.max(leaseUntil, at + LEASE_MS[activity]);
      scheduleQuiet();
      return;
    }
    const previousCommand = COMMANDS[current];
    const nextCommand = COMMANDS[activity];
    const previousDomain = commandDomain(previousCommand);
    const nextDomain = commandDomain(nextCommand);
    if (previousDomain && nextDomain && previousDomain !== nextDomain) {
      params.publish({
        type: "clear",
        domain: previousDomain as "attention" | "conversation" | "emotion" | "activity",
      });
    }
    current = activity;
    leaseUntil = at + LEASE_MS[activity];
    params.publish(nextCommand);
    scheduleQuiet();
  };
  const defer = (activity: CompanionActivity, delayMs: number) => {
    if (pending === activity) return;
    cancelTransition();
    pending = activity;
    transitionTimer = setTimer(() => {
      transitionTimer = undefined;
      const next = pending;
      pending = undefined;
      if (!disposed && next) apply(next, now());
    }, delayMs);
  };

  return {
    reduce(input) {
      if (
        disposed ||
        input.sessionKey !== params.sessionKey ||
        input.agentId !== params.agentId ||
        input.runId !== params.getRunId() ||
        !SOURCE_ALLOWLIST.has(input.source) ||
        !ACTIVITY_ALLOWLIST.has(input.activity) ||
        !Number.isSafeInteger(input.sourceSequence) ||
        input.sourceSequence < 0 ||
        !Number.isSafeInteger(input.observedAtMs) ||
        input.observedAtMs < 0
      ) {
        return false;
      }
      const previousSequence = lastSequence.get(input.source) ?? -1;
      if (input.sourceSequence <= previousSequence) return false;
      lastSequence.set(input.source, input.sourceSequence);

      const at = input.observedAtMs;
      if (input.activity === current) {
        cancelTransition();
        leaseUntil = Math.max(leaseUntil, at + LEASE_MS[input.activity]);
        scheduleQuiet();
        return false;
      }
      if (commandsEqual(COMMANDS[current], COMMANDS[input.activity])) {
        cancelTransition();
        current = input.activity;
        leaseUntil = Math.max(leaseUntil, at + LEASE_MS[input.activity]);
        scheduleQuiet();
        return false;
      }
      const leaseDelay = Math.max(0, leaseUntil - at);
      if (leaseDelay > 0 && PRIORITY[input.activity] < PRIORITY[current]) {
        defer(input.activity, leaseDelay);
        return false;
      }
      const chatty = ["item", "tool", "patch", "command-output"].includes(input.source);
      if (chatty && PRIORITY[input.activity] <= PRIORITY[current]) {
        defer(input.activity, Math.max(debounceMs, leaseDelay));
        return false;
      }
      apply(input.activity, at);
      return true;
    },
    force(input) {
      if (
        disposed ||
        input.sessionKey !== params.sessionKey ||
        input.agentId !== params.agentId ||
        input.runId !== params.getRunId() ||
        !SOURCE_ALLOWLIST.has(input.source) ||
        !ACTIVITY_ALLOWLIST.has(input.activity) ||
        !Number.isSafeInteger(input.sourceSequence) ||
        input.sourceSequence < 0 ||
        !Number.isSafeInteger(input.observedAtMs) ||
        input.observedAtMs < 0
      ) {
        return false;
      }
      const previousSequence = lastSequence.get(input.source) ?? -1;
      if (input.sourceSequence <= previousSequence) return false;
      lastSequence.set(input.source, input.sourceSequence);
      apply(input.activity, input.observedAtMs);
      return true;
    },
    dispose() {
      disposed = true;
      cancelTransition();
      if (quietTimer !== undefined) clearTimer(quietTimer);
      quietTimer = undefined;
      lastSequence.clear();
    },
  };
}
