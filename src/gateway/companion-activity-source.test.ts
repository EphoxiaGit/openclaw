import { describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { projectAgentEventToCompanionActivity } from "./companion-activity-source.js";

function project(stream: string, data: Record<string, unknown>) {
  return projectAgentEventToCompanionActivity({
    event: { runId: "private-run", seq: 7, ts: 100, stream, data } as AgentEventPayload,
    sessionKey: "private-session",
    agentId: "main",
    runId: "client-run",
  });
}

describe("Companion authoritative activity source", () => {
  it.each([
    ["lifecycle", { phase: "start" }, "thinking"],
    ["lifecycle", { phase: "end" }, "completed"],
    ["lifecycle", { phase: "error", error: "private" }, "warning"],
    ["lifecycle", { phase: "error", fallbackExhaustedFailure: true, error: "private" }, "error"],
    ["thinking", { text: "private reasoning" }, "thinking"],
    ["plan", { phase: "update", text: "private plan" }, "planning"],
    ["tool", { phase: "start", name: "private-tool" }, "tool-use"],
    ["approval", { phase: "requested", approvalId: "private" }, "waiting-user"],
    ["patch", { phase: "end", modified: ["private"] }, "coding"],
    ["command_output", { phase: "delta", output: "private" }, "coding"],
    ["item", { kind: "search", status: "running", title: "private" }, "searching"],
  ])("maps typed %s facts without projecting payload data", (stream, data, activity) => {
    expect(project(stream, data)).toEqual({
      sessionKey: "private-session",
      agentId: "main",
      runId: "client-run",
      source: stream === "command_output" ? "command-output" : stream,
      sourceSequence: 7,
      activity,
      observedAtMs: 100,
    });
  });

  it("does not infer activity from assistant prose or unknown typed values", () => {
    expect(project("assistant", { text: "I am searching and coding" })).toBeUndefined();
    expect(project("item", { kind: "unknown", title: "private" })).toBeUndefined();
  });
});
