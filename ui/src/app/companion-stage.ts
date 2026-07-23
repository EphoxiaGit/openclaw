/**
 * Local-only Companion renderer contract.
 *
 * The source is intentionally fixed: the Control UI never accepts a renderer
 * URL from route state, storage, the Gateway, or a model. This is not an
 * authorization boundary; it is a removable development-only presentation
 * mount with a single capability-reduced MessageChannel.
 */
export const COMPANION_LOCAL_STAGE_URL = "http://127.0.0.1:5184/";
export const COMPANION_LOCAL_STAGE_ORIGIN = new URL(COMPANION_LOCAL_STAGE_URL).origin;
export const COMPANION_AIRI_STAGE_URL = "http://127.0.0.1:5194/companion?openclaw=1";
export const COMPANION_AIRI_STAGE_ORIGIN = new URL(COMPANION_AIRI_STAGE_URL).origin;
export const COMPANION_LOCAL_STAGE_SEARCH = "?companion-stage=local";
export const COMPANION_CHANNEL_PROTOCOL = "openclaw.companion.v1" as const;
export const COMPANION_CHANNEL_MESSAGE = "openclaw-companion-channel" as const;

export type CompanionRenderer = "minimal" | "airi";
export type CompanionPresentation = Readonly<{
  model: "native" | "avatar-a" | "avatar-b";
  camera: "native" | "portrait" | "full";
  animation: "idle";
}>;
export type CompanionRendererSelection = Readonly<{
  renderer: CompanionRenderer;
  url: string;
  origin: string;
  presentation: CompanionPresentation;
}>;

export type CompanionAttachResult = Readonly<{
  attached: true;
  protocol: typeof COMPANION_CHANNEL_PROTOCOL;
  conversationId: string;
  phase: "idle";
}>;

export type CompanionEvent =
  | Readonly<{
      type: "state";
      conversationId: string;
      sequence: number;
      phase: "thinking" | "assistant-streaming" | "complete" | "cancelled" | "error";
    }>
  | Readonly<{
      type: "assistant-text";
      conversationId: string;
      sequence: number;
      mode: "append" | "replace";
      text: string;
      truncated: boolean;
    }>
  | Readonly<{
      type: "semantic-command";
      conversationId: string;
      sequence: number;
      command: CompanionSemanticCommand;
    }>;

export type CompanionSemanticCommand =
  | Readonly<{
      type: "set";
      state:
        | "attention.focus"
        | "conversation.listening"
        | "conversation.speaking"
        | "conversation.waiting"
        | "emotion.neutral"
        | "emotion.curious"
        | "emotion.concerned"
        | "emotion.sleepy"
        | "activity.thinking"
        | "activity.searching"
        | "activity.coding"
        | "activity.toolUse"
        | "activity.waitingForWorker"
        | "activity.error"
        | "activity.completed";
    }>
  | Readonly<{
      type: "clear";
      domain?: "attention" | "conversation" | "emotion" | "activity";
    }>;

export type CompanionSemanticRendererCommand = Readonly<{
  type: "set-companion-semantic";
  command: CompanionSemanticCommand;
  revision: number;
}>;

export type CompanionRendererIntent = Readonly<{
  type: "open-main-chat" | "cancel-response";
  sequence: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readSemanticCommand(value: unknown): CompanionSemanticCommand | null {
  if (!isRecord(value)) return null;
  if (value.type === "clear") {
    if (!hasOnlyKeys(value, ["type", "domain"])) return null;
    const domain = value.domain;
    if (
      domain !== undefined &&
      domain !== "attention" &&
      domain !== "conversation" &&
      domain !== "emotion" &&
      domain !== "activity"
    ) {
      return null;
    }
    return domain === undefined ? { type: "clear" } : { type: "clear", domain };
  }
  const states: readonly string[] = [
    "attention.focus",
    "conversation.listening",
    "conversation.speaking",
    "conversation.waiting",
    "emotion.neutral",
    "emotion.curious",
    "emotion.concerned",
    "emotion.sleepy",
    "activity.thinking",
    "activity.searching",
    "activity.coding",
    "activity.toolUse",
    "activity.waitingForWorker",
    "activity.error",
    "activity.completed",
  ];
  if (
    value.type !== "set" ||
    !hasOnlyKeys(value, ["type", "state"]) ||
    typeof value.state !== "string" ||
    !states.includes(value.state)
  ) {
    return null;
  }
  return {
    type: "set",
    state: value.state as Extract<CompanionSemanticCommand, { type: "set" }>["state"],
  };
}

export function readCompanionAttachResult(value: unknown): CompanionAttachResult | null {
  if (!isRecord(value)) return null;
  const conversationId = value.conversationId;
  if (
    value.attached !== true ||
    value.protocol !== COMPANION_CHANNEL_PROTOCOL ||
    value.phase !== "idle" ||
    typeof conversationId !== "string" ||
    conversationId.trim().length === 0
  ) {
    return null;
  }
  return {
    attached: true,
    protocol: COMPANION_CHANNEL_PROTOCOL,
    conversationId,
    phase: "idle",
  };
}

/** Returns a sanitized event so no unvalidated Gateway object crosses the UI boundary. */
export function readCompanionEvent(value: unknown): CompanionEvent | null {
  if (!isRecord(value)) return null;
  const conversationId = value.conversationId;
  if (
    typeof conversationId !== "string" ||
    conversationId.trim().length === 0 ||
    !isSequence(value.sequence)
  ) {
    return null;
  }
  if (value.type === "state") {
    const phase = value.phase;
    if (
      phase !== "thinking" &&
      phase !== "assistant-streaming" &&
      phase !== "complete" &&
      phase !== "cancelled" &&
      phase !== "error"
    ) {
      return null;
    }
    return { type: "state", conversationId, sequence: value.sequence, phase };
  }
  if (value.type === "semantic-command") {
    if (!hasOnlyKeys(value, ["type", "conversationId", "sequence", "command"])) return null;
    const command = readSemanticCommand(value.command);
    return command
      ? { type: "semantic-command", conversationId, sequence: value.sequence, command }
      : null;
  }
  if (
    value.type !== "assistant-text" ||
    (value.mode !== "append" && value.mode !== "replace") ||
    typeof value.text !== "string" ||
    value.text.length > 4_000 ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }
  return {
    type: "assistant-text",
    conversationId,
    sequence: value.sequence,
    mode: value.mode,
    text: value.text,
    truncated: value.truncated,
  };
}

export function readCompanionRendererIntent(value: unknown): CompanionRendererIntent | null {
  if (
    !isRecord(value) ||
    (value.type !== "open-main-chat" && value.type !== "cancel-response") ||
    !isSequence(value.sequence)
  ) {
    return null;
  }
  return { type: value.type, sequence: value.sequence };
}

export function readCompanionRendererSelection(config: unknown): CompanionRendererSelection {
  const gateway = isRecord(config) && isRecord(config.gateway) ? config.gateway : null;
  const controlUi = gateway && isRecord(gateway.controlUi) ? gateway.controlUi : null;
  const renderer = controlUi?.companionRenderer === "airi" ? "airi" : "minimal";
  const rawPresentation =
    controlUi && isRecord(controlUi.companionPresentation) ? controlUi.companionPresentation : null;
  const presentation: CompanionPresentation = {
    model:
      rawPresentation?.model === "avatar-a" || rawPresentation?.model === "avatar-b"
        ? rawPresentation.model
        : "native",
    camera:
      rawPresentation?.camera === "portrait" || rawPresentation?.camera === "full"
        ? rawPresentation.camera
        : "native",
    animation: "idle",
  };
  return renderer === "airi"
    ? {
        renderer,
        url: COMPANION_AIRI_STAGE_URL,
        origin: COMPANION_AIRI_STAGE_ORIGIN,
        presentation,
      }
    : {
        renderer,
        url: COMPANION_LOCAL_STAGE_URL,
        origin: COMPANION_LOCAL_STAGE_ORIGIN,
        presentation,
      };
}

export function isCompanionLocalStageEnabled(search: string): boolean {
  return new URLSearchParams(search).get("companion-stage") === "local";
}
