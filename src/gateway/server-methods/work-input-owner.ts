import { Value } from "typebox/value";
import {
  WorkInputChangedEventSchema,
  WorkInputRequestedEventSchema,
} from "../../../packages/gateway-protocol/src/schema/work-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkInputCreateOwner } from "../../work-inputs/service.js";
import { WorkInputConflictError, type WorkInputRecord } from "../../work-inputs/types.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayClient } from "./types.js";
import type { GatewayRequestContext } from "./types.js";

function safeTranscriptSummary(record: WorkInputRecord): string {
  const response = record.response;
  const responseSummary = response
    ? [
        response.text?.slice(0, 500),
        response.choiceIds?.length ? `choices=${response.choiceIds.join(",")}` : undefined,
        response.fileRefs?.length ? `managedFiles=${response.fileRefs.length}` : undefined,
        response.artifactRefs?.length ? `artifacts=${response.artifactRefs.length}` : undefined,
        response.secretRefs?.length
          ? `secretRefs=${response.secretRefs.map((ref) => `${ref.source}:${ref.provider}`).join(",")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    : undefined;
  return [
    `Work input ${record.request.id} (${record.request.kind}) is ${record.request.status}.`,
    `Prompt: ${record.request.prompt.slice(0, 500)}`,
    ...(responseSummary ? [`Response: ${responseSummary}`] : []),
  ].join("\n");
}

export function projectGatewayWorkInputTranscript(
  record: WorkInputRecord,
  cfg: OpenClawConfig,
): void {
  void appendInjectedAssistantMessageToTranscript({
    sessionKey: record.request.sessionKey,
    message: safeTranscriptSummary(record),
    label: "Work input",
    idempotencyKey: `work-input:${record.request.id}:${record.request.revision}`,
    config: cfg,
  });
}

function recipientIds(context: GatewayRequestContext, sessionKey: string): ReadonlySet<string> {
  return context.getSessionMessageSubscriberConnIds?.(sessionKey) ?? new Set<string>();
}

export function assertGatewayWorkInputVisible(
  context: GatewayRequestContext,
  client: GatewayClient | null,
  sessionKey: string,
): void {
  if (client?.connId && !recipientIds(context, sessionKey).has(client.connId)) {
    throw new WorkInputConflictError("work input is outside the active session visibility scope");
  }
}

export function broadcastGatewayWorkInputChanged(
  context: GatewayRequestContext,
  record: WorkInputRecord,
): void {
  context.broadcastToConnIds(
    "work.input.changed",
    Value.Parse(WorkInputChangedEventSchema, {
      requestId: record.request.id,
      revision: record.request.revision,
      status: record.request.status,
    }),
    recipientIds(context, record.request.sessionKey),
    { dropIfSlow: true },
  );
}

export function createGatewayWorkInputOwner(context: GatewayRequestContext): WorkInputCreateOwner {
  return {
    appendRequestedTranscript: (record) =>
      projectGatewayWorkInputTranscript(record, context.getRuntimeConfig()),
    emitRequested: (record) =>
      context.broadcastToConnIds(
        "work.input.requested",
        Value.Parse(WorkInputRequestedEventSchema, { request: record.request }),
        recipientIds(context, record.request.sessionKey),
        { dropIfSlow: true },
      ),
  };
}
