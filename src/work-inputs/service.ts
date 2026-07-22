import type { WorkInputResponse } from "../../packages/gateway-protocol/src/schema/work-inputs.js";
import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import {
  getTaskFlowById,
  resumeFlow,
  setFlowWaiting,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-runtime-internal.js";
import { WorkInputRepository } from "./repository.js";
import {
  WorkInputConflictError,
  type CreateWorkInputRequest,
  type WorkInputRecord,
} from "./types.js";

export type WorkInputReferenceValidators = {
  validateFileRef: (id: string) => Promise<boolean>;
  validateArtifactRef: (artifactId: string) => Promise<boolean>;
};

export type WorkInputCreateOwner = {
  appendRequestedTranscript: (record: WorkInputRecord) => void;
  emitRequested: (record: WorkInputRecord) => void;
};

function resumedState(
  state: JsonValue | undefined,
  requestId: string,
  response: WorkInputResponse,
): JsonValue {
  const base = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  return { ...base, inputResult: { requestId, response } } as JsonValue;
}

export class WorkInputService {
  constructor(
    readonly repository = new WorkInputRepository(),
    private readonly createOwner?: WorkInputCreateOwner,
  ) {}

  create(input: CreateWorkInputRequest): WorkInputRecord {
    const record = this.repository.create(input);
    if (!input.flow) {
      this.notifyCreated(record);
      return record;
    }
    const waiting = setFlowWaiting({
      flowId: input.flow.flowId,
      expectedRevision: input.flow.expectedRevision,
      waitJson: { kind: "input_request", requestId: record.request.id },
    });
    if (!waiting.applied) {
      this.repository.cancel({
        requestId: record.request.id,
        expectedRevision: 1,
        idempotencyKey: "flow-wait-failed",
        actorId: "system",
      });
      throw new WorkInputConflictError(`TaskFlow could not enter input wait: ${waiting.reason}`);
    }
    this.deliverExpired(record.request.id);
    const waitingRecord = this.repository.get(record.request.id);
    this.notifyCreated(waitingRecord);
    return waitingRecord;
  }

  list(filters: Parameters<WorkInputRepository["listPage"]>[0]) {
    this.deliverExpired();
    return this.repository.listPage(filters);
  }

  get(requestId: string): WorkInputRecord {
    this.deliverExpired(requestId);
    return this.repository.get(requestId);
  }

  private notifyCreated(record: WorkInputRecord): void {
    this.createOwner?.appendRequestedTranscript(record);
    this.createOwner?.emitRequested(record);
  }

  resolve(
    input: {
      requestId: string;
      expectedRevision: number;
      idempotencyKey: string;
      response: WorkInputResponse;
      actorId: string;
    },
    validators?: WorkInputReferenceValidators,
  ): Promise<WorkInputRecord> {
    return this.resolveValidated(input, validators);
  }

  private async resolveValidated(
    input: {
      requestId: string;
      expectedRevision: number;
      idempotencyKey: string;
      response: WorkInputResponse;
      actorId: string;
    },
    validators?: WorkInputReferenceValidators,
  ): Promise<WorkInputRecord> {
    this.deliverExpired(input.requestId);
    const replay = this.repository.replayResolve(input);
    if (replay) {
      this.deliver(replay);
      return this.repository.get(input.requestId);
    }
    for (const file of input.response.fileRefs ?? []) {
      if (!validators || !(await validators.validateFileRef(file.id))) {
        throw new WorkInputConflictError(`managed file reference is unavailable: ${file.id}`);
      }
    }
    for (const artifact of input.response.artifactRefs ?? []) {
      if (!validators || !(await validators.validateArtifactRef(artifact.artifactId))) {
        throw new WorkInputConflictError(
          `artifact reference is unavailable: ${artifact.artifactId}`,
        );
      }
    }
    const record = this.repository.resolve(input);
    this.deliver(record);
    return this.repository.get(input.requestId);
  }

  cancel(input: {
    requestId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
  }): WorkInputRecord {
    this.deliverExpired(input.requestId);
    const record = this.repository.cancel(input);
    this.deliver(record);
    return this.repository.get(input.requestId);
  }

  reconcile(): void {
    for (const record of this.repository.deliveryCandidates()) {
      this.deliver(record);
    }
  }

  private deliverExpired(requestId?: string): void {
    for (const record of this.repository.expirePending(requestId)) {
      this.deliver(record);
    }
  }

  deliver(record: WorkInputRecord): void {
    if (
      (record.deliveryStatus !== "pending" && record.deliveryStatus !== "failed") ||
      !record.flowId
    ) {
      return;
    }
    const flow = getTaskFlowById(record.flowId);
    if (!flow) {
      this.repository.markDelivery(record.request.id, "failed");
      return;
    }
    const alreadyApplied =
      flow.stateJson &&
      typeof flow.stateJson === "object" &&
      !Array.isArray(flow.stateJson) &&
      flow.stateJson.inputResult &&
      typeof flow.stateJson.inputResult === "object" &&
      !Array.isArray(flow.stateJson.inputResult) &&
      flow.stateJson.inputResult.requestId === record.request.id;
    if (alreadyApplied) {
      this.repository.markDelivery(record.request.id, "applied");
      return;
    }
    const terminalOutcome =
      record.request.status === "expired" ? record.expiryOutcome : record.cancelOutcome;
    if (
      record.request.status !== "resolved" &&
      terminalOutcome === "cancelled" &&
      flow.status === "cancelled"
    ) {
      this.repository.markDelivery(record.request.id, "applied");
      return;
    }
    const wait = flow.waitJson;
    if (
      flow.status !== "waiting" ||
      !wait ||
      typeof wait !== "object" ||
      Array.isArray(wait) ||
      wait.kind !== "input_request" ||
      wait.requestId !== record.request.id
    ) {
      this.repository.markDelivery(record.request.id, "failed");
      return;
    }
    if (record.request.status === "resolved" && record.response) {
      const resumed = resumeFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: resumedState(flow.stateJson, record.request.id, record.response),
      });
      this.repository.markDelivery(record.request.id, resumed.applied ? "applied" : "failed");
      return;
    }
    const outcome = terminalOutcome;
    const applied =
      outcome === "waiting"
        ? updateFlowRecordByIdExpectedRevision({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            patch: { status: "waiting", waitJson: null },
          }).applied
        : outcome === "cancelled"
          ? updateFlowRecordByIdExpectedRevision({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              patch: { status: "cancelled", waitJson: null, endedAt: Date.now() },
            }).applied
          : resumeFlow({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              stateJson: resumedState(flow.stateJson, record.request.id, {
                text: "rejected",
              }),
            }).applied;
    this.repository.markDelivery(record.request.id, applied ? "applied" : "failed");
  }
}

export function createWorkInputRequest(
  input: CreateWorkInputRequest,
  owner: WorkInputCreateOwner,
): WorkInputRecord {
  return new WorkInputService(new WorkInputRepository(), owner).create(input);
}
