import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCompanionAttachParams,
  validateCompanionCancelParams,
  validateCompanionDetachParams,
  type ChatEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompanionActivityInput } from "../companion-activity.js";
import type { CompanionBridgeEvent, CompanionRunStart } from "../companion-bridge.js";
import {
  createCompanionIntegration,
  type CompanionIntegration,
  type CompanionNativeChat,
} from "../companion-integration.js";
import { chatHandlers } from "./chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

const COMPANION_CONVERSATION_ID = "main-companion";
const runtimes = new WeakMap<GatewayRequestContext, CompanionGatewayRuntime>();

type CanonicalHandlerResult = { ok: boolean; payload?: unknown };

function isEnabled(cfg: OpenClawConfig): boolean {
  return cfg.gateway?.controlUi?.companionEnabled === true;
}

function isControlUi(client: GatewayClient | null): client is GatewayClient & { connId: string } {
  return (
    client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
    typeof client.connId === "string" &&
    client.connId.trim().length > 0
  );
}

async function invokeCanonicalChatHandler(params: {
  method: "chat.history" | "chat.abort";
  request: Record<string, unknown>;
  client: GatewayClient;
  context: GatewayRequestContext;
}): Promise<CanonicalHandlerResult> {
  let result: CanonicalHandlerResult | undefined;
  await chatHandlers[params.method]({
    req: { type: "req", id: `companion:${params.method}`, method: params.method },
    params: params.request,
    client: params.client,
    isWebchatConnect: () => false,
    context: params.context,
    respond: (ok, payload) => {
      result = { ok, payload };
    },
  });
  return result ?? { ok: false };
}

export type CompanionGatewayRuntime = Readonly<{
  handlers: GatewayRequestHandlers;
  detachConnection: (connId: string) => boolean;
  onChatSendStarted: (started: CompanionRunStart) => boolean;
  onChatEvent: (event: ChatEvent) => number;
  onActivity: (input: CompanionActivityInput) => boolean;
}>;

function createRuntime(context: GatewayRequestContext): CompanionGatewayRuntime {
  let nativeClient: GatewayClient | undefined;
  const nativeChat: CompanionNativeChat = {
    history: async (binding) => {
      if (!nativeClient) {
        throw new Error("companion_native_client_unavailable");
      }
      const result = await invokeCanonicalChatHandler({
        method: "chat.history",
        request: { sessionKey: binding.sessionKey, agentId: binding.agentId, limit: 200 },
        client: nativeClient,
        context,
      });
      if (!result.ok || !result.payload || typeof result.payload !== "object") {
        throw new Error("companion_history_unavailable");
      }
      const payload = result.payload as {
        messages?: unknown[];
        inFlightRun?: { runId: string; text: string };
      };
      return {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        ...(payload.inFlightRun ? { inFlightRun: payload.inFlightRun } : {}),
      };
    },
    abort: async (binding, runId) => {
      if (!nativeClient) {
        return { aborted: false };
      }
      const result = await invokeCanonicalChatHandler({
        method: "chat.abort",
        request: { sessionKey: binding.sessionKey, agentId: binding.agentId, runId },
        client: nativeClient,
        context,
      });
      const payload = result.payload as { aborted?: unknown } | undefined;
      return { aborted: result.ok && payload?.aborted === true };
    },
  };
  let integration: CompanionIntegration | undefined;
  try {
    integration = createCompanionIntegration({
      conversationId: COMPANION_CONVERSATION_ID,
      cfg: context.getRuntimeConfig(),
      nativeChat,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "companion_main_agent_not_configured") {
      throw error;
    }
  }

  const deny = (opts: GatewayRequestHandlerOptions, message: string) =>
    opts.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  const requireAvailable = (
    opts: GatewayRequestHandlerOptions,
  ): opts is GatewayRequestHandlerOptions & { client: GatewayClient & { connId: string } } => {
    if (!isEnabled(context.getRuntimeConfig())) {
      deny(opts, "companion is disabled");
      return false;
    }
    if (!isControlUi(opts.client)) {
      deny(opts, "companion requires the authenticated Control UI");
      return false;
    }
    if (!integration) {
      deny(opts, "companion Main agent is not configured");
      return false;
    }
    return true;
  };

  const handlers: GatewayRequestHandlers = {
    "companion.attach": async (opts) => {
      if (!validateCompanionAttachParams(opts.params)) {
        deny(
          opts,
          `invalid companion.attach params: ${formatValidationErrors(validateCompanionAttachParams.errors)}`,
        );
        return;
      }
      if (!requireAvailable(opts)) return;
      const attachClient = opts.client;
      const claimedNativeClient = nativeClient === undefined;
      if (claimedNativeClient) {
        nativeClient = attachClient;
      }
      const buffered: CompanionBridgeEvent[] = [];
      let responding = true;
      let attached: boolean;
      try {
        attached = await integration!.attachAuthorizedRecipient({
          connId: attachClient.connId,
          publish: (event) => {
            if (responding) {
              buffered.push(event);
            } else {
              context.broadcastToConnIds("companion.event", event, new Set([attachClient.connId]), {
                dropIfSlow: true,
              });
            }
          },
        });
      } catch (error) {
        if (claimedNativeClient && nativeClient === attachClient) {
          nativeClient = undefined;
        }
        throw error;
      }
      if (!attached) {
        opts.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "companion already attached"),
        );
        responding = false;
        if (claimedNativeClient && nativeClient === attachClient) {
          nativeClient = undefined;
        }
        return;
      }
      opts.respond(true, { attached: true, ...integration!.bootstrap() });
      responding = false;
      for (const event of buffered) {
        context.broadcastToConnIds("companion.event", event, new Set([opts.client.connId]), {
          dropIfSlow: true,
        });
      }
    },
    "companion.detach": async (opts) => {
      if (!validateCompanionDetachParams(opts.params)) {
        deny(
          opts,
          `invalid companion.detach params: ${formatValidationErrors(validateCompanionDetachParams.errors)}`,
        );
        return;
      }
      if (!requireAvailable(opts)) return;
      const detached = integration!.detachRecipient(opts.client.connId);
      if (detached && nativeClient === opts.client) nativeClient = undefined;
      opts.respond(true, { detached });
    },
    "companion.cancel": async (opts) => {
      if (!validateCompanionCancelParams(opts.params)) {
        deny(
          opts,
          `invalid companion.cancel params: ${formatValidationErrors(validateCompanionCancelParams.errors)}`,
        );
        return;
      }
      if (!requireAvailable(opts)) return;
      opts.respond(true, { aborted: await integration!.cancelCurrent(opts.client.connId) });
    },
  };

  return {
    handlers,
    detachConnection: (connId) => {
      const detached = integration?.detachRecipient(connId) ?? false;
      if (detached && nativeClient?.connId === connId) nativeClient = undefined;
      return detached;
    },
    onChatSendStarted: (started) => integration?.onChatSendStarted(started) ?? false,
    onChatEvent: (event) => integration?.onChatEvent(event) ?? 0,
    onActivity: (input) => integration?.onActivity(input) ?? false,
  };
}

export function getCompanionGatewayRuntime(
  context: GatewayRequestContext,
): CompanionGatewayRuntime {
  let runtime = runtimes.get(context);
  if (!runtime) {
    runtime = createRuntime(context);
    runtimes.set(context, runtime);
    context.detachCompanionConnection = runtime.detachConnection;
    context.onCompanionChatSendStarted = runtime.onChatSendStarted;
    context.onCompanionChatEvent = runtime.onChatEvent;
    context.onCompanionActivity = runtime.onActivity;
  }
  return runtime;
}

export const companionHandlers: GatewayRequestHandlers = {
  "companion.attach": (opts) =>
    getCompanionGatewayRuntime(opts.context).handlers["companion.attach"](opts),
  "companion.detach": (opts) =>
    getCompanionGatewayRuntime(opts.context).handlers["companion.detach"](opts),
  "companion.cancel": (opts) =>
    getCompanionGatewayRuntime(opts.context).handlers["companion.cancel"](opts),
};
