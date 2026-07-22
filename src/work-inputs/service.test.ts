import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { WorkInputRepository } from "./repository.js";
import { WorkInputService } from "./service.js";

afterEach(() => resetTaskFlowRegistryForTests());

describe("WorkInputService", () => {
  it("waits and resumes a TaskFlow exactly once with a sanitized response", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-service-" },
      async () => {
        resetTaskFlowRegistryForTests();
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/work-input",
          goal: "Ask operator",
        });
        expect(flow).not.toBeNull();
        if (!flow) {
          return;
        }
        const appendRequestedTranscript = vi.fn();
        const emitRequested = vi.fn();
        const service = new WorkInputService(undefined, {
          appendRequestedTranscript,
          emitRequested,
        });
        const request = service.create({
          kind: "question",
          sessionKey: "agent:main:main",
          prompt: "Continue?",
          creator: { type: "system", label: "TaskFlow" },
          options: [{ id: "yes", label: "Yes" }],
          allowMultiple: false,
          allowFreeText: false,
          flow: { flowId: flow.flowId, expectedRevision: flow.revision },
        });
        expect(getTaskFlowById(flow.flowId)).toMatchObject({
          status: "waiting",
          waitJson: { kind: "input_request", requestId: request.request.id },
        });
        expect(appendRequestedTranscript).toHaveBeenCalledWith(request);
        expect(emitRequested).toHaveBeenCalledWith(request);
        const resolved = await service.resolve({
          requestId: request.request.id,
          expectedRevision: 1,
          idempotencyKey: "resolve-once",
          actorId: "device:test",
          response: { choiceIds: ["yes"] },
        });
        expect(resolved.deliveryStatus).toBe("applied");
        const resumed = getTaskFlowById(flow.flowId);
        expect(resumed).toMatchObject({
          status: "queued",
          revision: 2,
          waitJson: null,
          stateJson: {
            inputResult: { requestId: request.request.id, response: { choiceIds: ["yes"] } },
          },
        });
        service.reconcile();
        expect(getTaskFlowById(flow.flowId)?.revision).toBe(2);
      },
    );
  });

  it("validates managed references before persistence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-reference-validation-" },
      async () => {
        const service = new WorkInputService();
        const request = service.create({
          kind: "add_information",
          sessionKey: "agent:main:main",
          prompt: "Attach proof",
          creator: { type: "system", label: "TaskFlow" },
          allowedFields: ["fileRefs", "artifactRefs"],
        });
        const validateFileRef = vi.fn(async () => true);
        const validateArtifactRef = vi.fn(async () => false);
        await expect(
          service.resolve(
            {
              requestId: request.request.id,
              expectedRevision: 1,
              idempotencyKey: "proof",
              actorId: "device:test",
              response: {
                fileRefs: [{ id: "managed-file" }],
                artifactRefs: [{ artifactId: "missing-artifact" }],
              },
            },
            { validateFileRef, validateArtifactRef },
          ),
        ).rejects.toThrow(/artifact reference is unavailable/);
        expect(service.repository.get(request.request.id).request.status).toBe("pending");
        expect(validateFileRef).toHaveBeenCalledWith("managed-file");
        expect(validateArtifactRef).toHaveBeenCalledWith("missing-artifact");
      },
    );
  });

  it("replays a durable resolution before revalidating transient references", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-reference-replay-" },
      async () => {
        const service = new WorkInputService();
        const request = service.create({
          kind: "add_information",
          sessionKey: "agent:main:main",
          prompt: "Attach proof",
          creator: { type: "system", label: "TaskFlow" },
          allowedFields: ["fileRefs"],
        });
        const validateFileRef = vi.fn(async () => true);
        const input = {
          requestId: request.request.id,
          expectedRevision: 1,
          idempotencyKey: "proof-once",
          actorId: "device:test",
          response: { fileRefs: [{ id: "managed-file" }] },
        };
        const first = await service.resolve(input, {
          validateFileRef,
          validateArtifactRef: vi.fn(async () => true),
        });
        validateFileRef.mockResolvedValue(false);

        await expect(
          service.resolve(input, {
            validateFileRef,
            validateArtifactRef: vi.fn(async () => false),
          }),
        ).resolves.toEqual(first);
        expect(validateFileRef).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("applies a producer-declared expiry outcome through reconciliation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-expiry-delivery-" },
      async () => {
        resetTaskFlowRegistryForTests();
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/work-input-expiry",
          goal: "Wait for operator",
        });
        if (!flow) {
          throw new Error("expected managed TaskFlow");
        }
        const service = new WorkInputService();
        const request = service.create({
          kind: "approval",
          sessionKey: "agent:main:main",
          prompt: "Proceed?",
          creator: { type: "system", label: "TaskFlow" },
          expiresAt: Date.now() - 1,
          expiryOutcome: "cancelled",
          flow: { flowId: flow.flowId, expectedRevision: flow.revision },
        });
        expect(request.request.status).toBe("expired");
        service.reconcile();
        expect(service.repository.get(request.request.id).deliveryStatus).toBe("applied");
        expect(getTaskFlowById(flow.flowId)?.status).toBe("cancelled");
      },
    );
  });

  it("applies expiry during a live list refresh without waiting for restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-live-expiry-" },
      async () => {
        resetTaskFlowRegistryForTests();
        let now = 100;
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/work-input-live-expiry",
          goal: "Wait for operator",
        });
        if (!flow) {
          throw new Error("expected managed TaskFlow");
        }
        const service = new WorkInputService(new WorkInputRepository({ now: () => now }));
        const request = service.create({
          kind: "approval",
          sessionKey: "agent:main:main",
          prompt: "Proceed?",
          creator: { type: "system", label: "TaskFlow" },
          expiresAt: 200,
          expiryOutcome: "cancelled",
          flow: { flowId: flow.flowId, expectedRevision: flow.revision },
        });
        now = 300;

        expect(service.list({ sessionKey: "agent:main:main" }).records).toHaveLength(1);
        expect(service.get(request.request.id)).toMatchObject({
          request: { status: "expired" },
          deliveryStatus: "applied",
        });
        expect(getTaskFlowById(flow.flowId)?.status).toBe("cancelled");
      },
    );
  });

  it("clears the terminal request pointer for a declared waiting outcome", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "work-input-waiting-outcome-" },
      async () => {
        resetTaskFlowRegistryForTests();
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/work-input-waiting-outcome",
          goal: "Wait for operator",
        });
        if (!flow) {
          throw new Error("expected managed TaskFlow");
        }
        const service = new WorkInputService();
        const request = service.create({
          kind: "approval",
          sessionKey: "agent:main:main",
          prompt: "Proceed?",
          creator: { type: "system", label: "TaskFlow" },
          cancelOutcome: "waiting",
          flow: { flowId: flow.flowId, expectedRevision: flow.revision },
        });

        const cancelled = service.cancel({
          requestId: request.request.id,
          expectedRevision: 1,
          idempotencyKey: "cancel-waiting",
          actorId: "device:test",
        });
        expect(cancelled.deliveryStatus).toBe("applied");
        expect(getTaskFlowById(flow.flowId)).toMatchObject({
          status: "waiting",
          waitJson: null,
        });
      },
    );
  });
});
