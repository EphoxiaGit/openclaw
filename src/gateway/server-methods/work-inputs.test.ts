import { describe, expect, it, vi } from "vitest";
import type { WorkInputService } from "../../work-inputs/service.js";
import type { WorkInputRecord } from "../../work-inputs/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { createWorkInputHandlers } from "./work-inputs.js";

const hoisted = vi.hoisted(() => ({ appendTranscript: vi.fn() }));

vi.mock("./chat-transcript-inject.js", () => ({
  appendInjectedAssistantMessageToTranscript: hoisted.appendTranscript,
}));

const baseRequest = {
  id: "request-1",
  revision: 1,
  status: "pending" as const,
  sessionKey: "agent:main:main",
  createdAt: 1,
  updatedAt: 1,
  prompt: "Continue?",
  creator: { type: "system" as const, label: "TaskFlow" },
  kind: "approval" as const,
  decisions: ["approve", "reject"] as Array<"approve" | "reject">,
};

function record(overrides: Partial<WorkInputRecord> = {}): WorkInputRecord {
  return {
    request: baseRequest,
    deliveryStatus: "not_applicable",
    cancelOutcome: "cancelled",
    expiryOutcome: "cancelled",
    ...overrides,
  };
}

function service(overrides: Record<string, unknown> = {}) {
  const current = record();
  return {
    repository: {
      listPage: vi.fn(() => ({ records: [current], nextCursor: 12 })),
      get: vi.fn(() => current),
    },
    list: vi.fn(() => ({ records: [current], nextCursor: 12 })),
    get: vi.fn(() => current),
    resolve: vi.fn(async () => current),
    cancel: vi.fn(() => current),
    ...overrides,
  } as unknown as WorkInputService;
}

async function invoke(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  connId = "visible",
) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  const recipients = new Set(["visible", "second-viewer"]);
  await handlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: { connId, connect: { device: { id: "test-device" } } },
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({}),
      getSessionMessageSubscriberConnIds: () => recipients,
      broadcastToConnIds,
    },
  } as unknown as GatewayRequestHandlerOptions);
  return { respond, broadcastToConnIds, recipients };
}

describe("work input gateway handlers", () => {
  it("returns a durable cursor only to an active session viewer", async () => {
    const owner = service();
    const handlers = createWorkInputHandlers({ service: owner });
    const visible = await invoke(handlers, "work.inputs.list", {
      sessionKey: "agent:main:main",
      limit: 1,
    });
    expect(visible.respond).toHaveBeenCalledWith(
      true,
      { requests: [baseRequest], nextCursor: 12 },
      undefined,
    );

    const hidden = await invoke(
      handlers,
      "work.inputs.list",
      { sessionKey: "agent:main:main" },
      "not-subscribed",
    );
    expect(hidden.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("targets change events and redacts SecretRef locators from transcript projection", async () => {
    hoisted.appendTranscript.mockClear();
    const resolved = record({
      request: {
        ...baseRequest,
        kind: "secret_ref",
        status: "resolved",
        revision: 2,
      },
      response: {
        secretRefs: [{ source: "env", provider: "default", id: "SENTINEL_SECRET_LOCATOR" }],
      },
    });
    const owner = service({
      repository: { get: vi.fn(() => record()) },
      get: vi.fn(() => record()),
      resolve: vi.fn(async () => resolved),
    });
    const handlers = createWorkInputHandlers({ service: owner });
    const result = await invoke(handlers, "work.inputs.resolve", {
      requestId: "request-1",
      expectedRevision: 1,
      idempotencyKey: "resolve-once",
      response: {
        secretRefs: [{ source: "env", provider: "default", id: "SENTINEL_SECRET_LOCATOR" }],
      },
    });

    expect(result.respond).toHaveBeenCalledWith(
      true,
      { request: resolved.request, response: resolved.response },
      undefined,
    );
    expect(result.broadcastToConnIds).toHaveBeenCalledWith(
      "work.input.changed",
      { requestId: "request-1", revision: 2, status: "resolved" },
      result.recipients,
      { dropIfSlow: true },
    );
    expect(JSON.stringify(hoisted.appendTranscript.mock.calls)).not.toContain(
      "SENTINEL_SECRET_LOCATOR",
    );
    expect(JSON.stringify(hoisted.appendTranscript.mock.calls)).toContain("secretRefs=env:default");
  });
});
