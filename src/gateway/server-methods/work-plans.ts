import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWorkPlansCreateParams,
  validateWorkPlansGetParams,
  validateWorkPlansHistoryParams,
  validateWorkPlansMutateParams,
  validateWorkPlansProjectionParams,
  validateWorkProjectsCreateParams,
  validateWorkProjectsGetParams,
  validateWorkProjectsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import {
  WorkPlanConflictError,
  WorkPlanNotFoundError,
  WorkPlanValidationError,
} from "../../work-plans/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import type { GatewayClient } from "./types.js";

const repository = new WorkPlanRepository();
function authenticatedActorId(client: GatewayClient | null): string {
  const deviceId = client?.connect.device?.id;
  return deviceId ? `device:${deviceId}` : `gateway-connection:${client?.connId ?? "internal"}`;
}
function invalid(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  method: string,
  errors: unknown,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}
function execute(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  operation: () => unknown,
): void {
  try {
    respond(true, operation());
  } catch (error) {
    if (
      error instanceof WorkPlanConflictError ||
      error instanceof WorkPlanValidationError ||
      error instanceof WorkPlanNotFoundError
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return;
    }
    throw error;
  }
}

export const workPlansHandlers: GatewayRequestHandlers = {
  "work.projects.create": ({ params, respond, client }) => {
    if (!validateWorkProjectsCreateParams(params)) {
      return invalid(respond, "work.projects.create", validateWorkProjectsCreateParams.errors);
    }
    execute(respond, () =>
      repository.createProject({ ...params, actorId: authenticatedActorId(client) }),
    );
  },
  "work.projects.list": ({ params, respond }) => {
    if (!validateWorkProjectsListParams(params)) {
      return invalid(respond, "work.projects.list", validateWorkProjectsListParams.errors);
    }
    execute(respond, () => ({ projects: repository.listProjects() }));
  },
  "work.projects.get": ({ params, respond }) => {
    if (!validateWorkProjectsGetParams(params)) {
      return invalid(respond, "work.projects.get", validateWorkProjectsGetParams.errors);
    }
    execute(respond, () => ({ project: repository.getProject(params.projectId) }));
  },
  "work.plans.create": ({ params, respond, client }) => {
    if (!validateWorkPlansCreateParams(params)) {
      return invalid(respond, "work.plans.create", validateWorkPlansCreateParams.errors);
    }
    execute(respond, () => ({
      plan: repository.createPlan({ ...params, actorId: authenticatedActorId(client) }),
    }));
  },
  "work.plans.get": ({ params, respond }) => {
    if (!validateWorkPlansGetParams(params)) {
      return invalid(respond, "work.plans.get", validateWorkPlansGetParams.errors);
    }
    execute(respond, () => ({ plan: repository.getPlan(params.planId) }));
  },
  "work.plans.mutate": ({ params, respond, client }) => {
    if (!validateWorkPlansMutateParams(params)) {
      return invalid(respond, "work.plans.mutate", validateWorkPlansMutateParams.errors);
    }
    execute(respond, () => ({
      plan: repository.mutate({ ...params, actorId: authenticatedActorId(client) }),
    }));
  },
  "work.plans.history": ({ params, respond }) => {
    if (!validateWorkPlansHistoryParams(params)) {
      return invalid(respond, "work.plans.history", validateWorkPlansHistoryParams.errors);
    }
    execute(respond, () => ({
      transitions: repository.history(params.planId),
      lineage: repository.lineage(params.planId),
    }));
  },
  "work.plans.projection": ({ params, respond }) => {
    if (!validateWorkPlansProjectionParams(params)) {
      return invalid(respond, "work.plans.projection", validateWorkPlansProjectionParams.errors);
    }
    execute(respond, () => ({ projection: repository.getPlan(params.planId).projection }));
  },
};
