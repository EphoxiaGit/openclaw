import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { SessionScope } from "../config/sessions/types.js";
import {
  createCompanionActivityPolicy,
  type CompanionActivityInput,
  type CompanionActivityPolicy,
} from "./companion-activity.js";
import {
  COMPANION_MAIN_AGENT_ID,
  createCompanionBridge,
  type CompanionBootstrap,
  type CompanionBridge,
  type CompanionBridgeBinding,
  type CompanionBridgeEvent,
  type CompanionHistorySnapshot,
  type CompanionRunStart,
} from "./companion-bridge.js";

export type CompanionRecipient = Readonly<{
  connId: string;
  publish: (event: CompanionBridgeEvent) => void;
}>;

export type CompanionNativeChat = Readonly<{
  history: (binding: CompanionBridgeBinding) => Promise<CompanionHistorySnapshot>;
  abort: (
    binding: CompanionBridgeBinding,
    runId: string,
  ) => Promise<Readonly<{ aborted: boolean }>>;
}>;

export type CompanionIntegration = Readonly<{
  bootstrap: () => CompanionBootstrap;
  attachAuthorizedRecipient: (recipient: CompanionRecipient) => Promise<boolean>;
  detachRecipient: (connId: string) => boolean;
  onChatSendStarted: (started: CompanionRunStart) => boolean;
  onChatEvent: (event: ChatEvent) => number;
  onActivity: (input: CompanionActivityInput) => boolean;
  cancelCurrent: (connId: string) => Promise<boolean>;
}>;

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`invalid_companion_${name}`);
  }
  return value;
}

/**
 * Builds the fixed server-owned Main binding. The recipient never supplies or
 * receives the OpenClaw session key or agent id.
 */
export function resolveCompanionMainBinding(params: {
  conversationId: string;
  cfg?: {
    session?: { scope?: SessionScope; mainKey?: string };
    agents?: { list?: Array<{ id?: string }> };
  };
}): CompanionBridgeBinding {
  const configuredAgents = params.cfg?.agents?.list;
  if (
    !Array.isArray(configuredAgents) ||
    !configuredAgents.some((entry) => entry.id?.trim().toLowerCase() === COMPANION_MAIN_AGENT_ID)
  ) {
    throw new Error("companion_main_agent_not_configured");
  }
  return {
    conversationId: requireNonEmpty("conversation_id", params.conversationId),
    sessionKey:
      params.cfg?.session?.scope === "global"
        ? "global"
        : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: COMPANION_MAIN_AGENT_ID }),
    agentId: COMPANION_MAIN_AGENT_ID,
  };
}

/**
 * Creates an inactive integration seam around native chat authority. It does
 * not register a Gateway method, select a connection, advertise a protocol,
 * persist data, or open a transport.
 */
export function createCompanionIntegration(params: {
  conversationId: string;
  cfg?: {
    session?: { scope?: SessionScope; mainKey?: string };
    agents?: { list?: Array<{ id?: string }> };
  };
  nativeChat: CompanionNativeChat;
}): CompanionIntegration {
  const binding = resolveCompanionMainBinding(params);
  let bridge: CompanionBridge = createCompanionBridge(binding);
  let recipient: CompanionRecipient | undefined;
  let pendingConnId: string | undefined;
  let attachGeneration = 0;
  let currentRunId: string | undefined;
  let abortPendingRunId: string | undefined;
  let activityPolicy: CompanionActivityPolicy | undefined;

  const resetActivityPolicy = () => {
    activityPolicy?.dispose();
    activityPolicy = createCompanionActivityPolicy({
      sessionKey: binding.sessionKey,
      agentId: binding.agentId,
      getRunId: () => currentRunId,
      publish: (command) => {
        recipient?.publish(bridge.projectSemanticCommand(command));
      },
    });
  };

  const publishAll = (events: readonly CompanionBridgeEvent[]) => {
    const activeRecipient = recipient;
    if (!activeRecipient) {
      return 0;
    }
    for (const event of events) {
      activeRecipient.publish(event);
    }
    return events.length;
  };

  return {
    bootstrap: () => bridge.bootstrap(),

    attachAuthorizedRecipient: async (nextRecipient) => {
      const connId = requireNonEmpty("connection_id", nextRecipient.connId);
      if (recipient || pendingConnId) {
        return false;
      }

      const generation = ++attachGeneration;
      pendingConnId = connId;
      let snapshot: CompanionHistorySnapshot;
      try {
        snapshot = await params.nativeChat.history(binding);
      } catch (error) {
        if (attachGeneration === generation) {
          pendingConnId = undefined;
        }
        throw error;
      }

      if (attachGeneration !== generation || pendingConnId !== connId || recipient) {
        return false;
      }

      pendingConnId = undefined;
      bridge = createCompanionBridge(binding);
      recipient = nextRecipient;
      currentRunId = snapshot.inFlightRun?.runId.trim() || undefined;
      abortPendingRunId = undefined;
      resetActivityPolicy();
      publishAll(bridge.recover(snapshot));
      return true;
    },

    detachRecipient: (connId) => {
      const normalizedConnId = connId.trim();
      if (pendingConnId === normalizedConnId) {
        attachGeneration += 1;
        pendingConnId = undefined;
        return true;
      }
      if (recipient?.connId !== normalizedConnId) {
        return false;
      }
      recipient = undefined;
      currentRunId = undefined;
      abortPendingRunId = undefined;
      activityPolicy?.dispose();
      activityPolicy = undefined;
      bridge = createCompanionBridge(binding);
      return true;
    },

    onChatSendStarted: (started) => {
      if (!recipient) {
        return false;
      }
      const event = bridge.beginRun(started);
      if (!event) {
        return false;
      }
      currentRunId = started.runId;
      abortPendingRunId = undefined;
      resetActivityPolicy();
      recipient.publish(event);
      return true;
    },

    onChatEvent: (event) => {
      if (!recipient) {
        return 0;
      }
      const events = bridge.projectChatEvent(event);
      const count = publishAll(events);
      if (
        count > 0 &&
        event.runId === currentRunId &&
        events.some(
          (projected) =>
            projected.type === "state" &&
            (projected.phase === "complete" ||
              projected.phase === "cancelled" ||
              projected.phase === "error"),
        )
      ) {
        currentRunId = undefined;
        abortPendingRunId = undefined;
      }
      return count;
    },

    onActivity: (input) => activityPolicy?.reduce(input) ?? false,

    cancelCurrent: async (connId) => {
      if (recipient?.connId !== connId || !currentRunId || abortPendingRunId === currentRunId) {
        return false;
      }
      const runId = currentRunId;
      abortPendingRunId = runId;
      let result: Readonly<{ aborted: boolean }>;
      try {
        result = await params.nativeChat.abort(binding, runId);
      } catch (error) {
        if (abortPendingRunId === runId) {
          abortPendingRunId = undefined;
        }
        throw error;
      }
      if (!result.aborted && abortPendingRunId === runId) {
        abortPendingRunId = undefined;
      }
      return result.aborted;
    },
  };
}
