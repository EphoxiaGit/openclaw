import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  WorkInputsCancelParamsSchema,
  WorkInputsGetParamsSchema,
  WorkInputsListParamsSchema,
  WorkInputsResolveParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/work-inputs.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import { WorkInputService } from "../../work-inputs/service.js";
import {
  WorkInputConflictError,
  WorkInputNotFoundError,
  WorkInputValidationError,
  type WorkInputRecord,
} from "../../work-inputs/types.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import { validateManagedArtifactReference } from "./artifacts.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import {
  assertGatewayWorkInputVisible,
  broadcastGatewayWorkInputChanged,
  projectGatewayWorkInputTranscript,
} from "./work-input-owner.js";

function actorId(client: GatewayClient | null): string {
  return client?.connect.device?.id
    ? `device:${client.connect.device.id}`
    : `gateway-connection:${client?.connId ?? "internal"}`;
}

function publicResult(record: WorkInputRecord) {
  return { request: record.request, ...(record.response ? { response: record.response } : {}) };
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
        assertGatewayWorkInputVisible(context, client, sessionKey);
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
        assertGatewayWorkInputVisible(context, client, record.request.sessionKey);
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
        assertGatewayWorkInputVisible(context, client, current.request.sessionKey);
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
        broadcastGatewayWorkInputChanged(context, record);
        projectGatewayWorkInputTranscript(record, context.getRuntimeConfig());
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
        assertGatewayWorkInputVisible(context, client, current.request.sessionKey);
        const record = service.cancel({ ...params, actorId: actorId(client) });
        broadcastGatewayWorkInputChanged(context, record);
        projectGatewayWorkInputTranscript(record, context.getRuntimeConfig());
        return publicResult(record);
      });
    },
  };
}

export const workInputHandlers = createWorkInputHandlers();
