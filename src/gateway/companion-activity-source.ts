import type { AgentEventPayload } from "../infra/agent-events.js";
import type { CompanionActivity, CompanionActivityInput } from "./companion-activity.js";

function activityForEvent(event: AgentEventPayload): CompanionActivity | undefined {
  const phase = typeof event.data.phase === "string" ? event.data.phase : undefined;
  const status = typeof event.data.status === "string" ? event.data.status : undefined;
  switch (event.stream) {
    case "lifecycle":
      if (phase === "start") return "thinking";
      if (phase === "end") return "completed";
      if (phase === "error") {
        return event.data.fallbackExhaustedFailure === true ? "error" : "warning";
      }
      return undefined;
    case "thinking":
      return "thinking";
    case "plan":
      return "planning";
    case "approval":
      return phase === "requested" ? "waiting-user" : phase === "resolved" ? "thinking" : undefined;
    case "patch":
    case "command_output":
      return "coding";
    case "tool":
      return phase === "start" ? "tool-use" : phase === "result" ? "thinking" : undefined;
    case "item": {
      if (status === "failed") return "warning";
      if (status === "blocked") return "waiting-user";
      const kind = typeof event.data.kind === "string" ? event.data.kind : undefined;
      if (kind === "search") return "searching";
      if (kind === "command" || kind === "patch") return "coding";
      if (kind === "tool") return "tool-use";
      if (kind === "analysis") return "thinking";
      return undefined;
    }
    case "error":
      return "error";
    default:
      return undefined;
  }
}

export function projectAgentEventToCompanionActivity(params: {
  event: AgentEventPayload;
  sessionKey?: string;
  agentId?: string;
  runId: string;
}): CompanionActivityInput | undefined {
  const activity = activityForEvent(params.event);
  if (!activity || !params.sessionKey || !params.agentId) return undefined;
  const source = params.event.stream === "command_output" ? "command-output" : params.event.stream;
  if (
    source !== "lifecycle" &&
    source !== "thinking" &&
    source !== "plan" &&
    source !== "item" &&
    source !== "tool" &&
    source !== "approval" &&
    source !== "patch" &&
    source !== "command-output"
  ) {
    return undefined;
  }
  return {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    runId: params.runId,
    source,
    sourceSequence: params.event.seq,
    activity,
    observedAtMs: params.event.ts,
  };
}
