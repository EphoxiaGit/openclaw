import type {
  ChatEvent,
  CompanionBootstrap,
  CompanionEvent,
  CompanionSemanticCommand,
} from "../../packages/gateway-protocol/src/index.js";

// Server-owned Companion Bridge contract.
//
// This module intentionally does not open a socket, select an agent, or own a
// chat session. A future authorized gateway integration feeds it the existing
// authoritative chat lifecycle for one fixed server-side binding.

export const COMPANION_BRIDGE_PROTOCOL = "openclaw.companion.v1" as const;
export const MAX_COMPANION_TRANSCRIPT_CHARS = 4_000;
export const COMPANION_MAIN_AGENT_ID = "main" as const;

export type CompanionBridgeBinding = Readonly<{
  /** Opaque client-facing identifier; not an OpenClaw session key. */
  conversationId: string;
  /** Server-only OpenClaw session binding. */
  sessionKey: string;
  /** Server-only fixed assistant binding. */
  agentId: string;
}>;

export type CompanionStateEvent = Extract<CompanionEvent, { type: "state" }>;
export type CompanionTranscriptEvent = Extract<CompanionEvent, { type: "assistant-text" }>;
export type CompanionBridgeEvent = CompanionEvent;

export type CompanionRunStart = Readonly<{
  status: "started";
  runId: string;
  sessionKey: string;
  agentId: string;
}>;

export type CompanionHistorySnapshot = Readonly<{
  messages: readonly unknown[];
  inFlightRun?: Readonly<{
    runId: string;
    text: string;
  }>;
}>;

export type CompanionBridge = Readonly<{
  bootstrap: () => CompanionBootstrap;
  beginRun: (input: CompanionRunStart) => CompanionStateEvent | null;
  projectChatEvent: (input: ChatEvent) => readonly CompanionBridgeEvent[];
  recover: (snapshot: CompanionHistorySnapshot) => readonly CompanionBridgeEvent[];
  projectSemanticCommand: (command: CompanionSemanticCommand) => CompanionBridgeEvent;
}>;

/**
 * Server-owned, non-buffering presentation sink. A future authorized gateway
 * route supplies this one callback only after it has selected the Companion
 * recipient; this module deliberately has no browser, socket, persistence, or
 * credential dependency.
 */
export type CompanionBridgePublisher = (event: CompanionBridgeEvent) => void;

/**
 * Imperative facade for server-side lifecycle wiring. It publishes only the
 * redacted output of a fixed CompanionBridge and exposes no binding details.
 */
export type CompanionBridgeDelivery = Readonly<{
  bootstrap: () => CompanionBootstrap;
  beginRun: (input: CompanionRunStart) => boolean;
  projectChatEvent: (input: ChatEvent) => number;
  recover: (snapshot: CompanionHistorySnapshot) => number;
}>;

type RunProjection = {
  lastSourceSequence: number;
  lastSourceWasDelta: boolean;
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

function readLatestAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as Record<string, unknown>;
    if (entry.role !== "assistant") {
      continue;
    }
    const text = readAssistantMessageText(message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

/**
 * Creates a local projection for one server-configured Main conversation.
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

  if (fixedBinding.agentId !== COMPANION_MAIN_AGENT_ID) {
    throw new Error("invalid_companion_main_agent");
  }

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
        input.status !== "started" ||
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
        lastSourceWasDelta: false,
        started: true,
        sawAssistantText: false,
        terminal: false,
      });
      return emitState("thinking");
    },

    projectChatEvent: (input) => {
      if (
        input.sessionKey !== fixedBinding.sessionKey ||
        (input.agentId !== undefined && input.agentId !== fixedBinding.agentId)
      ) {
        return [];
      }
      const run = runs.get(input.runId);
      if (
        !run ||
        run.terminal ||
        input.seq < run.lastSourceSequence ||
        (input.seq === run.lastSourceSequence &&
          (input.state === "delta" || !run.lastSourceWasDelta))
      ) {
        return [];
      }
      run.lastSourceSequence = input.seq;
      run.lastSourceWasDelta = input.state === "delta";

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

    recover: (snapshot) => {
      const inFlightRun = snapshot.inFlightRun;
      if (inFlightRun && inFlightRun.runId.trim().length > 0) {
        runs.clear();
        runs.set(inFlightRun.runId, {
          lastSourceSequence: -1,
          lastSourceWasDelta: false,
          started: true,
          sawAssistantText: inFlightRun.text.length > 0,
          terminal: false,
        });
        const events: CompanionBridgeEvent[] = [
          emitState(inFlightRun.text.length > 0 ? "assistant-streaming" : "thinking"),
        ];
        if (inFlightRun.text.length > 0) {
          events.push(emitText("replace", inFlightRun.text));
        }
        return events;
      }

      runs.clear();
      const latestAssistantText = readLatestAssistantText(snapshot.messages);
      if (!latestAssistantText) {
        return [];
      }
      return [emitText("replace", latestAssistantText), emitState("complete")];
    },
    projectSemanticCommand: (command) => ({
      type: "semantic-command",
      conversationId: fixedBinding.conversationId,
      sequence: ++nextSequence,
      command,
    }),
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
    recover: (snapshot) => publishAll(bridge.recover(snapshot)),
  };
}
