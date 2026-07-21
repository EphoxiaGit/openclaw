// Server-owned Companion Bridge contract.
//
// This module intentionally does not open a socket, select an agent, or own a
// chat session. A future authorized gateway integration feeds it the existing
// authoritative chat lifecycle for one fixed server-side binding.

export const COMPANION_BRIDGE_PROTOCOL = "openclaw.companion.v1" as const;
export const MAX_COMPANION_TRANSCRIPT_CHARS = 4_000;

export type CompanionBridgeBinding = Readonly<{
  /** Opaque client-facing identifier; not an OpenClaw session key. */
  conversationId: string;
  /** Server-only OpenClaw session binding. */
  sessionKey: string;
  /** Server-only fixed assistant binding. */
  agentId: string;
}>;

export type CompanionChatEvent = Readonly<{
  runId: string;
  sessionKey: string;
  agentId?: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  deltaText?: string;
  replace?: boolean;
  message?: unknown;
}>;

export type CompanionBootstrap = Readonly<{
  protocol: typeof COMPANION_BRIDGE_PROTOCOL;
  conversationId: string;
  phase: "idle";
}>;

export type CompanionStateEvent = Readonly<{
  type: "state";
  conversationId: string;
  sequence: number;
  phase: "thinking" | "assistant-streaming" | "complete" | "cancelled" | "error";
}>;

export type CompanionTranscriptEvent = Readonly<{
  type: "assistant-text";
  conversationId: string;
  sequence: number;
  mode: "append" | "replace";
  text: string;
  truncated: boolean;
}>;

export type CompanionBridgeEvent = CompanionStateEvent | CompanionTranscriptEvent;

export type CompanionRunStart = Readonly<{
  runId: string;
  sessionKey: string;
  agentId: string;
}>;

export type CompanionBridge = Readonly<{
  bootstrap: () => CompanionBootstrap;
  beginRun: (input: CompanionRunStart) => CompanionStateEvent | null;
  projectChatEvent: (input: unknown) => readonly CompanionBridgeEvent[];
}>;

/**
 * Server-owned presentation sink. A future authorized gateway route supplies
 * this callback only after it has selected the Companion recipient; this
 * module deliberately has no browser, socket, or credential dependency.
 */
export type CompanionBridgePublisher = (event: CompanionBridgeEvent) => void;

/**
 * Imperative facade for server-side lifecycle wiring. It publishes only the
 * redacted output of a fixed CompanionBridge and exposes no binding details.
 */
export type CompanionBridgeDelivery = Readonly<{
  bootstrap: () => CompanionBootstrap;
  beginRun: (input: CompanionRunStart) => boolean;
  projectChatEvent: (input: unknown) => number;
}>;

type RunProjection = {
  lastSourceSequence: number;
  started: boolean;
  sawAssistantText: boolean;
  terminal: boolean;
};

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`invalid_companion_${name}`);
  }
  return value;
}

function isCompanionChatEvent(value: unknown): value is CompanionChatEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.runId === "string" &&
    typeof event.sessionKey === "string" &&
    typeof event.seq === "number" &&
    Number.isInteger(event.seq) &&
    event.seq >= 0 &&
    (event.state === "delta" ||
      event.state === "final" ||
      event.state === "aborted" ||
      event.state === "error")
  );
}

function boundedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_COMPANION_TRANSCRIPT_CHARS) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, MAX_COMPANION_TRANSCRIPT_CHARS), truncated: true };
}

function readAssistantMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const text = entry.content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
  return text || undefined;
}

/**
 * Creates a local projection for one server-configured OpenClaw conversation.
 * Browser-facing events deliberately omit the session key, agent id, run id,
 * provider, tool data, usage, and raw error details.
 */
export function createCompanionBridge(binding: CompanionBridgeBinding): CompanionBridge {
  const fixedBinding = {
    conversationId: requireNonEmpty("conversation_id", binding.conversationId),
    sessionKey: requireNonEmpty("session_key", binding.sessionKey),
    agentId: requireNonEmpty("agent_id", binding.agentId),
  };
  const runs = new Map<string, RunProjection>();
  let nextSequence = 0;

  const emitState = (phase: CompanionStateEvent["phase"]): CompanionStateEvent => ({
    type: "state",
    conversationId: fixedBinding.conversationId,
    sequence: ++nextSequence,
    phase,
  });
  const emitText = (
    mode: CompanionTranscriptEvent["mode"],
    source: string,
  ): CompanionTranscriptEvent => {
    const text = boundedText(source);
    return {
      type: "assistant-text",
      conversationId: fixedBinding.conversationId,
      sequence: ++nextSequence,
      mode,
      ...text,
    };
  };

  return {
    bootstrap: () => ({
      protocol: COMPANION_BRIDGE_PROTOCOL,
      conversationId: fixedBinding.conversationId,
      phase: "idle",
    }),

    beginRun: (input) => {
      if (
        input.sessionKey !== fixedBinding.sessionKey ||
        input.agentId !== fixedBinding.agentId ||
        input.runId.trim().length === 0
      ) {
        return null;
      }
      const run = runs.get(input.runId);
      if (run?.started) {
        return null;
      }
      runs.set(input.runId, {
        lastSourceSequence: -1,
        started: true,
        sawAssistantText: false,
        terminal: false,
      });
      return emitState("thinking");
    },

    projectChatEvent: (input) => {
      if (!isCompanionChatEvent(input)) {
        return [];
      }
      if (input.sessionKey !== fixedBinding.sessionKey || input.agentId !== fixedBinding.agentId) {
        return [];
      }
      const run = runs.get(input.runId);
      if (!run || run.terminal || input.seq <= run.lastSourceSequence) {
        return [];
      }
      run.lastSourceSequence = input.seq;

      if (input.state === "delta") {
        const events: CompanionBridgeEvent[] = [];
        if (!run.sawAssistantText) {
          events.push(emitState("assistant-streaming"));
        }
        const delta = typeof input.deltaText === "string" ? input.deltaText : "";
        if (delta.length > 0) {
          events.push(emitText(input.replace === true ? "replace" : "append", delta));
          run.sawAssistantText = true;
        }
        return events;
      }

      if (input.state === "final") {
        const events: CompanionBridgeEvent[] = [];
        if (!run.sawAssistantText) {
          const text = readAssistantMessageText(input.message);
          if (text) {
            events.push(emitText("replace", text));
          }
        }
        run.terminal = true;
        events.push(emitState("complete"));
        return events;
      }
      run.terminal = true;
      return [emitState(input.state === "aborted" ? "cancelled" : "error")];
    },
  };
}

/**
 * Creates the testable server delivery seam for a fixed Companion binding.
 * This does not register a Gateway event listener or send browser traffic.
 */
export function createCompanionBridgeDelivery(params: {
  binding: CompanionBridgeBinding;
  publish: CompanionBridgePublisher;
}): CompanionBridgeDelivery {
  const bridge = createCompanionBridge(params.binding);
  const publishAll = (events: readonly CompanionBridgeEvent[]) => {
    for (const event of events) {
      params.publish(event);
    }
    return events.length;
  };

  return {
    bootstrap: bridge.bootstrap,
    beginRun: (input) => {
      const event = bridge.beginRun(input);
      if (!event) {
        return false;
      }
      params.publish(event);
      return true;
    },
    projectChatEvent: (input) => publishAll(bridge.projectChatEvent(input)),
  };
}
