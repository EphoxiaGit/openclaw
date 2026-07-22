import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  WorkInputChangedEventSchema,
  WorkInputRequestedEventSchema,
  WorkInputsCancelParamsSchema,
  WorkInputsGetParamsSchema,
  WorkInputsListParamsSchema,
  WorkInputsResolveParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/work-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import { WorkInputService, type WorkInputCreateOwner } from "../../work-inputs/service.js";
import {
  WorkInputConflictError,
  WorkInputNotFoundError,
  WorkInputValidationError,
  type WorkInputRecord,
} from "../../work-inputs/types.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import { validateManagedArtifactReference } from "./artifacts.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import type { GatewayRequestContext } from "./types.js";

function actorId(client: GatewayClient | null): string {
  return client?.connect.device?.id
    ? `device:${client.connect.device.id}`
    : `gateway-connection:${client?.connId ?? "internal"}`;
}

function publicResult(record: WorkInputRecord) {
  return { request: record.request, ...(record.response ? { response: record.response } : {}) };
}

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

function projectTranscript(record: WorkInputRecord, cfg: OpenClawConfig) {
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

function assertVisible(
  context: GatewayRequestContext,
  client: GatewayClient | null,
  sessionKey: string,
): void {
  if (!client?.connId) {
    return;
  }
  if (!recipientIds(context, sessionKey).has(client.connId)) {
    throw new WorkInputConflictError("work input is outside the active session visibility scope");
  }
}

function broadcastChanged(context: GatewayRequestContext, record: WorkInputRecord): void {
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
    appendRequestedTranscript: (record) => projectTranscript(record, context.getRuntimeConfig()),
    emitRequested: (record) =>
      context.broadcastToConnIds(
        "work.input.requested",
        Value.Parse(WorkInputRequestedEventSchema, { request: record.request }),
        recipientIds(context, record.request.sessionKey),
        { dropIfSlow: true },
      ),
  };
}

async function handle(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  run: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    respond(true, await run(), undefined);
  } catch (error) {
    if (
      error instanceof WorkInputNotFoundError ||
      error instanceof WorkInputConflictError ||
      error instanceof WorkInputValidationError
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return;
    }
    throw error;
  }
}

export function createWorkInputHandlers(
  input: { service?: WorkInputService } = {},
): GatewayRequestHandlers {
  const service = input.service ?? new WorkInputService();
  const projects = new WorkPlanRepository();
  return {
    "work.inputs.list": async ({ params, respond, context, client }) => {
      if (!Value.Check(WorkInputsListParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid work.inputs.list params"),
        );
      }
      await handle(respond, () => {
        if (!params.sessionKey && !params.projectId) {
          throw new WorkInputValidationError("work.inputs.list requires sessionKey or projectId");
        }
        let sessionKey = params.sessionKey;
        if (!sessionKey && params.projectId) {
          try {
            sessionKey = projects.getProject(params.projectId).primaryConversationId;
          } catch {
            throw new WorkInputConflictError("work input project is not visible");
          }
        }
        if (!sessionKey) {
          throw new WorkInputConflictError("work input session is not visible");
        }
        assertVisible(context, client, sessionKey);
        const page = service.list(params);
        return {
          requests: page.records.map((record) => record.request),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
    "work.inputs.get": async ({ params, respond, context, client }) => {
      if (!Value.Check(WorkInputsGetParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid work.inputs.get params"),
        );
      }
      await handle(respond, () => {
        const record = service.get(params.requestId);
        assertVisible(context, client, record.request.sessionKey);
        return publicResult(record);
      });
    },
    "work.inputs.resolve": async ({ params, respond, context, client }) => {
      if (!Value.Check(WorkInputsResolveParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid work.inputs.resolve params"),
        );
      }
      await handle(respond, async () => {
        const current = service.get(params.requestId);
        assertVisible(context, client, current.request.sessionKey);
        const record = await service.resolve(
          { ...params, actorId: actorId(client) },
          {
            validateFileRef: async (id) =>
              (await resolveInboundMediaReference(
                `media://inbound/${encodeURIComponent(id)}`,
              ).catch(() => null)) !== null,
            validateArtifactRef: (artifactId) =>
              validateManagedArtifactReference({
                artifactId,
                sessionKey: current.request.sessionKey,
                config: context.getRuntimeConfig(),
              }),
          },
        );
        broadcastChanged(context, record);
        projectTranscript(record, context.getRuntimeConfig());
        return publicResult(record);
      });
    },
    "work.inputs.cancel": async ({ params, respond, context, client }) => {
      if (!Value.Check(WorkInputsCancelParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid work.inputs.cancel params"),
        );
      }
      await handle(respond, () => {
        const current = service.get(params.requestId);
        assertVisible(context, client, current.request.sessionKey);
        const record = service.cancel({ ...params, actorId: actorId(client) });
        broadcastChanged(context, record);
        projectTranscript(record, context.getRuntimeConfig());
        return publicResult(record);
      });
    },
  };
}

export const workInputHandlers = createWorkInputHandlers();
