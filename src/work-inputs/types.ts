import type {
  WorkInputRequest,
  WorkInputResponse,
} from "../../packages/gateway-protocol/src/schema/work-inputs.js";

export type WorkInputStatus = WorkInputRequest["status"];
export type WorkInputDeliveryStatus = "not_applicable" | "pending" | "applied" | "failed";
export type WorkInputTerminalOutcome = "waiting" | "cancelled" | "rejected";
export type WorkInputCreator = { type: "system" | "agent"; label: string };

type CommonCreate = {
  sessionKey: string;
  projectId?: string;
  planId?: string;
  stepId?: string;
  taskId?: string;
  prompt: string;
  description?: string;
  expiresAt?: number;
  creator: WorkInputCreator;
  flow?: { flowId: string; expectedRevision: number };
  cancelOutcome?: WorkInputTerminalOutcome;
  expiryOutcome?: WorkInputTerminalOutcome;
};

export type CreateWorkInputRequest = CommonCreate &
  (
    | {
        kind: "question";
        options: Array<{ id: string; label: string }>;
        allowMultiple: boolean;
        allowFreeText: boolean;
      }
    | {
        kind: "add_information";
        allowedFields: Array<"text" | "fileRefs" | "artifactRefs">;
      }
    | { kind: "approval"; decisions?: Array<"approve" | "reject"> }
    | { kind: "secret_ref"; providerAliases?: string[]; targetPaths?: string[] }
  );

export type WorkInputRecord = {
  request: WorkInputRequest;
  response?: WorkInputResponse;
  flowId?: string;
  flowRevision?: number;
  deliveryStatus: WorkInputDeliveryStatus;
  cancelOutcome: WorkInputTerminalOutcome;
  expiryOutcome: WorkInputTerminalOutcome;
};

export class WorkInputNotFoundError extends Error {}
export class WorkInputConflictError extends Error {}
export class WorkInputValidationError extends Error {}
