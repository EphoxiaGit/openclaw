import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWorkCapsulesUpdateParams,
  validateWorkCheckpointsCreateParams,
  validateWorkDocumentsGetParams,
  validateWorkDocumentsListParams,
  validateWorkHandoffsCreateParams,
  validateWorkPlansCreateParams,
  validateWorkPlansGetParams,
  validateWorkPlansHistoryParams,
  validateWorkPlansMutateParams,
  validateWorkPlansProjectionParams,
  validateWorkProjectsCreateParams,
  validateWorkProjectsCreateRegisteredParams,
  validateWorkProjectsGetParams,
  validateWorkProjectsListParams,
  validateWorkProjectContextGetParams,
  validateWorkRegisteredProjectsGetParams,
  validateWorkRegisteredProjectsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ProjectContextRepository } from "../../work-plans/project-context-repository.js";
import { WorkPlanRepository } from "../../work-plans/repository.js";
import {
  WorkPlanConflictError,
  WorkPlanNotFoundError,
  WorkPlanValidationError,
} from "../../work-plans/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import type { GatewayClient } from "./types.js";

const repository = new WorkPlanRepository();
const projectContextRepository = new ProjectContextRepository();
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
  "work.registeredProjects.list": ({ params, respond }) => {
    if (!validateWorkRegisteredProjectsListParams(params)) {
      return invalid(
        respond,
        "work.registeredProjects.list",
        validateWorkRegisteredProjectsListParams.errors,
      );
    }
    execute(respond, () => ({ projects: projectContextRepository.listRegisteredProjects() }));
  },
  "work.registeredProjects.get": ({ params, respond }) => {
    if (!validateWorkRegisteredProjectsGetParams(params)) {
      return invalid(
        respond,
        "work.registeredProjects.get",
        validateWorkRegisteredProjectsGetParams.errors,
      );
    }
    execute(respond, () => ({
      project: projectContextRepository.getRegisteredProject(params.registeredProjectId),
    }));
  },
  "work.projects.createRegistered": ({ params, respond, client }) => {
    if (!validateWorkProjectsCreateRegisteredParams(params)) {
      return invalid(
        respond,
        "work.projects.createRegistered",
        validateWorkProjectsCreateRegisteredParams.errors,
      );
    }
    execute(respond, () =>
      projectContextRepository.createRegisteredWorkProject({
        ...params,
        actorId: authenticatedActorId(client),
      }),
    );
  },
  "work.projectContext.get": ({ params, respond }) => {
    if (!validateWorkProjectContextGetParams(params)) {
      return invalid(
        respond,
        "work.projectContext.get",
        validateWorkProjectContextGetParams.errors,
      );
    }
    execute(respond, () => ({
      context: projectContextRepository.getProjectContext(params.projectId),
    }));
  },
  "work.documents.list": ({ params, respond }) => {
    if (!validateWorkDocumentsListParams(params)) {
      return invalid(respond, "work.documents.list", validateWorkDocumentsListParams.errors);
    }
    execute(respond, () => ({
      documents: projectContextRepository.listDocuments(params.projectId),
    }));
  },
  "work.documents.get": ({ params, respond }) => {
    if (!validateWorkDocumentsGetParams(params)) {
      return invalid(respond, "work.documents.get", validateWorkDocumentsGetParams.errors);
    }
    execute(respond, () => ({
      document: projectContextRepository.getDocument(
        params.projectId,
        params.documentId,
        params.revision,
      ),
    }));
  },
  "work.capsules.update": ({ params, respond, client }) => {
    if (!validateWorkCapsulesUpdateParams(params)) {
      return invalid(respond, "work.capsules.update", validateWorkCapsulesUpdateParams.errors);
    }
    execute(respond, () =>
      projectContextRepository.updateCapsule({
        ...params,
        actorId: authenticatedActorId(client),
      }),
    );
  },
  "work.checkpoints.create": ({ params, respond, client }) => {
    if (!validateWorkCheckpointsCreateParams(params)) {
      return invalid(
        respond,
        "work.checkpoints.create",
        validateWorkCheckpointsCreateParams.errors,
      );
    }
    execute(respond, () =>
      projectContextRepository.createCheckpoint({
        ...params,
        actorId: authenticatedActorId(client),
      }),
    );
  },
  "work.handoffs.create": ({ params, respond, client }) => {
    if (!validateWorkHandoffsCreateParams(params)) {
      return invalid(respond, "work.handoffs.create", validateWorkHandoffsCreateParams.errors);
    }
    execute(respond, () =>
      projectContextRepository.createHandoff({
        ...params,
        actorId: authenticatedActorId(client),
      }),
    );
  },
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
