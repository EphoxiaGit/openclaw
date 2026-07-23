import type { CompanionBridgeEvent } from "./companion-bridge.js";

export const COMPANION_SPEAKING_LEASE_MS = 2_000;
export const COMPANION_TERMINAL_LEASE_MS = 1_200;

export type CompanionRenderState = "idle" | "thinking" | "responding" | "speaking" | "settled";

export type CompanionRendererCommand = Readonly<{
  type: "set-companion-state";
  state: CompanionRenderState;
  revision: number;
  expiresAtMs?: number;
}>;

export type CompanionAudioPresentationEvent = Readonly<{
  type: "audio-presentation";
  conversationId: string;
  sequence: number;
  state: "speaking" | "silent";
  observedAtMs: number;
}>;

export type CompanionEmbodimentInput =
  | Readonly<{
      type: "bridge-event";
      event: CompanionBridgeEvent;
      observedAtMs: number;
    }>
  | CompanionAudioPresentationEvent
  | Readonly<{
      type: "clock";
      observedAtMs: number;
    }>;

export type CompanionEmbodiment = Readonly<{
  bootstrap: () => CompanionRendererCommand;
  reduce: (input: CompanionEmbodimentInput) => CompanionRendererCommand | null;
  reset: () => CompanionRendererCommand;
}>;

type TimedState = Readonly<{
  state: CompanionRenderState;
  expiresAtMs?: number;
}>;

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reduces already-typed Companion presentation facts into a single, closed
 * renderer vocabulary. It never examines transcript text and owns no I/O.
 */
export function createCompanionEmbodiment(conversationId: string): CompanionEmbodiment {
  if (conversationId.trim().length === 0) {
    throw new Error("invalid_companion_conversation_id");
  }

  let lifecycle: TimedState = { state: "idle" };
  let speakingUntilMs: number | undefined;
  let lastBridgeSequence = -1;
  let lastAudioSequence = -1;
  let revision = 0;
  let rendered: TimedState | undefined;

  const currentState = (nowMs: number): TimedState => {
    if (speakingUntilMs !== undefined && nowMs < speakingUntilMs) {
      return { state: "speaking", expiresAtMs: speakingUntilMs };
    }
    speakingUntilMs = undefined;
    if (lifecycle.expiresAtMs !== undefined && nowMs >= lifecycle.expiresAtMs) {
      lifecycle = { state: "idle" };
    }
    return lifecycle;
  };

  const emitIfChanged = (nowMs: number, force = false): CompanionRendererCommand | null => {
    const next = currentState(nowMs);
    if (!force && rendered?.state === next.state && rendered.expiresAtMs === next.expiresAtMs) {
      return null;
    }
    rendered = next;
    return {
      type: "set-companion-state",
      state: next.state,
      revision: ++revision,
      ...(next.expiresAtMs === undefined ? {} : { expiresAtMs: next.expiresAtMs }),
    };
  };

  const reset = (): CompanionRendererCommand => {
    lifecycle = { state: "idle" };
    speakingUntilMs = undefined;
    lastBridgeSequence = -1;
    lastAudioSequence = -1;
    return emitIfChanged(0, true) as CompanionRendererCommand;
  };

  return {
    bootstrap: () => emitIfChanged(0, true) as CompanionRendererCommand,
    reset,
    reduce: (input) => {
      if (!isTime(input.observedAtMs)) {
        return null;
      }

      if (input.type === "clock") {
        return emitIfChanged(input.observedAtMs);
      }

      if (input.type === "audio-presentation") {
        if (
          input.conversationId !== conversationId ||
          !isSequence(input.sequence) ||
          input.sequence <= lastAudioSequence ||
          (input.state !== "speaking" && input.state !== "silent")
        ) {
          return null;
        }
        lastAudioSequence = input.sequence;
        speakingUntilMs =
          input.state === "speaking" ? input.observedAtMs + COMPANION_SPEAKING_LEASE_MS : undefined;
        return emitIfChanged(input.observedAtMs);
      }

      const event = input.event;
      if (
        event.conversationId !== conversationId ||
        !isSequence(event.sequence) ||
        event.sequence <= lastBridgeSequence
      ) {
        return null;
      }
      lastBridgeSequence = event.sequence;

      if (event.type === "assistant-text") {
        return emitIfChanged(input.observedAtMs);
      }
      if (event.type === "semantic-command") {
        return null;
      }

      switch (event.phase) {
        case "thinking":
          lifecycle = { state: "thinking" };
          break;
        case "assistant-streaming":
          lifecycle = { state: "responding" };
          break;
        case "complete":
        case "cancelled":
        case "error":
          lifecycle = {
            state: "settled",
            expiresAtMs: input.observedAtMs + COMPANION_TERMINAL_LEASE_MS,
          };
          break;
      }
      return emitIfChanged(input.observedAtMs);
    },
  };
}
