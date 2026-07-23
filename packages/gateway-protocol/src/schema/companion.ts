import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const CompanionAttachParamsSchema = Type.Object({}, { additionalProperties: false });
export type CompanionAttachParams = Static<typeof CompanionAttachParamsSchema>;

export const CompanionDetachParamsSchema = Type.Object({}, { additionalProperties: false });
export type CompanionDetachParams = Static<typeof CompanionDetachParamsSchema>;

export const CompanionCancelParamsSchema = Type.Object({}, { additionalProperties: false });
export type CompanionCancelParams = Static<typeof CompanionCancelParamsSchema>;

export const CompanionBootstrapSchema = Type.Object(
  {
    protocol: Type.Literal("openclaw.companion.v1"),
    conversationId: NonEmptyString,
    phase: Type.Literal("idle"),
  },
  { additionalProperties: false },
);
export type CompanionBootstrap = Static<typeof CompanionBootstrapSchema>;

const CompanionSemanticStateSchema = Type.Union([
  Type.Literal("attention.focus"),
  Type.Literal("conversation.listening"),
  Type.Literal("conversation.speaking"),
  Type.Literal("conversation.waiting"),
  Type.Literal("emotion.neutral"),
  Type.Literal("emotion.curious"),
  Type.Literal("emotion.concerned"),
  Type.Literal("emotion.sleepy"),
  Type.Literal("activity.thinking"),
  Type.Literal("activity.searching"),
  Type.Literal("activity.coding"),
  Type.Literal("activity.toolUse"),
  Type.Literal("activity.waitingForWorker"),
  Type.Literal("activity.error"),
  Type.Literal("activity.completed"),
]);

export const CompanionSemanticCommandSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("set"),
      state: CompanionSemanticStateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("clear"),
      domain: Type.Optional(
        Type.Union([
          Type.Literal("attention"),
          Type.Literal("conversation"),
          Type.Literal("emotion"),
          Type.Literal("activity"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
]);
export type CompanionSemanticCommand = Static<typeof CompanionSemanticCommandSchema>;

export const CompanionEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("state"),
      conversationId: NonEmptyString,
      sequence: Type.Integer({ minimum: 1 }),
      phase: Type.Union([
        Type.Literal("thinking"),
        Type.Literal("assistant-streaming"),
        Type.Literal("complete"),
        Type.Literal("cancelled"),
        Type.Literal("error"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("assistant-text"),
      conversationId: NonEmptyString,
      sequence: Type.Integer({ minimum: 1 }),
      mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
      text: Type.String({ maxLength: 4_000 }),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("semantic-command"),
      conversationId: NonEmptyString,
      sequence: Type.Integer({ minimum: 1 }),
      command: CompanionSemanticCommandSchema,
    },
    { additionalProperties: false },
  ),
]);
export type CompanionEvent = Static<typeof CompanionEventSchema>;

export const CompanionAttachResultSchema = Type.Object(
  {
    attached: Type.Literal(true),
    protocol: Type.Literal("openclaw.companion.v1"),
    conversationId: NonEmptyString,
    phase: Type.Literal("idle"),
  },
  { additionalProperties: false },
);
export type CompanionAttachResult = Static<typeof CompanionAttachResultSchema>;

export const CompanionDetachResultSchema = Type.Object(
  { detached: Type.Boolean() },
  { additionalProperties: false },
);
export type CompanionDetachResult = Static<typeof CompanionDetachResultSchema>;

export const CompanionCancelResultSchema = Type.Object(
  { aborted: Type.Boolean() },
  { additionalProperties: false },
);
export type CompanionCancelResult = Static<typeof CompanionCancelResultSchema>;
