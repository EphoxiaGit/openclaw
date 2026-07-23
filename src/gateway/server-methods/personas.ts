import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  PersonaChangedEventSchema,
  PersonaSelectionChangedEventSchema,
  PersonasAffectImpulseParamsSchema,
  PersonasCognitionListParamsSchema,
  PersonasCognitionStartParamsSchema,
  PersonasCreateParamsSchema,
  PersonasGetParamsSchema,
  PersonasHistoryParamsSchema,
  PersonasExperimentsAcceptParamsSchema,
  PersonasExperimentsProposeParamsSchema,
  PersonasLifecycleParamsSchema,
  PersonasListParamsSchema,
  PersonasMemoryCorrectParamsSchema,
  PersonasMemoryCreateParamsSchema,
  PersonasMemoryDeleteParamsSchema,
  PersonasMemoryExportParamsSchema,
  PersonasMemoryListParamsSchema,
  PersonasReviseParamsSchema,
  PersonasSelectionGetParamsSchema,
  PersonasSelectionSetParamsSchema,
  PersonasUpdateParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/personas.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "../../memory-host-sdk/dreaming.js";
import { PersonaAffectRepository } from "../../personas/affect-repository.js";
import {
  CognitiveOpportunityConflictError,
  CognitiveOpportunityNotFoundError,
  CognitiveOpportunityRepository,
  CognitiveOpportunityValidationError,
  type CognitiveOutputKind,
} from "../../personas/cognitive-opportunity.js";
import { PersonaMemoryRepository } from "../../personas/memory-repository.js";
import {
  PersonaMemoryConflictError,
  PersonaMemoryNotFoundError,
  PersonaMemoryValidationError,
} from "../../personas/memory-types.js";
import {
  PersonaConflictError,
  PersonaNotFoundError,
  PersonaRepository,
  PersonaValidationError,
} from "../../personas/repository.js";
import { projectPersonaWithVoice } from "../../personas/voice-binding.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { createManagedTaskFlow, failFlow, finishFlow } from "../../tasks/task-flow-registry.js";
import { WorkInputService } from "../../work-inputs/service.js";
import { WorkInputConflictError, WorkInputValidationError } from "../../work-inputs/types.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import { createGatewayWorkInputOwner } from "./work-input-owner.js";

function actorId(client: GatewayClient | null): string {
  return client?.connect.device?.id
    ? `device:${client.connect.device.id}`
    : `gateway-connection:${client?.connId ?? "internal"}`;
}

function handle(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  run: () => unknown,
) {
  try {
    respond(true, run(), undefined);
  } catch (error) {
    if (error instanceof PersonaNotFoundError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    } else if (error instanceof PersonaConflictError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    } else if (error instanceof PersonaValidationError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    } else if (
      error instanceof PersonaMemoryNotFoundError ||
      error instanceof PersonaMemoryConflictError ||
      error instanceof PersonaMemoryValidationError ||
      error instanceof CognitiveOpportunityNotFoundError ||
      error instanceof CognitiveOpportunityConflictError ||
      error instanceof CognitiveOpportunityValidationError ||
      error instanceof WorkInputConflictError ||
      error instanceof WorkInputValidationError
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    } else {
      throw error;
    }
  }
}

export function createPersonaHandlers(
  input: {
    repository?: PersonaRepository;
    affectRepository?: PersonaAffectRepository;
    memoryRepository?: PersonaMemoryRepository;
    cognitiveOpportunityRepository?: CognitiveOpportunityRepository;
  } = {},
): GatewayRequestHandlers {
  const repository = input.repository ?? new PersonaRepository();
  let affectRepository = input.affectRepository;
  const affect = () => (affectRepository ??= new PersonaAffectRepository());
  const memoryRepository = input.memoryRepository ?? new PersonaMemoryRepository();
  const cognitiveOpportunityRepository =
    input.cognitiveOpportunityRepository ?? new CognitiveOpportunityRepository();
  const configured = (context: Parameters<GatewayRequestHandlers[string]>[0]["context"]) =>
    new Set(listAgentIds(context.getRuntimeConfig()));
  return {
    "personas.list": ({ params, respond, context }) => {
      if (!Value.Check(PersonasListParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.list params"),
        );
      handle(respond, () => ({
        personas: repository
          .list(configured(context), params.includeArchived)
          .map((persona) => projectPersonaWithVoice(context.getRuntimeConfig(), persona)),
      }));
    },
    "personas.get": ({ params, respond, context }) => {
      if (!Value.Check(PersonasGetParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.get params"),
        );
      handle(respond, () => {
        const persona = repository.get(params.personaId, configured(context));
        const revisions = repository.listRevisions(params.personaId);
        return {
          persona: projectPersonaWithVoice(context.getRuntimeConfig(), persona),
          activeRevision: repository.getRevision(persona.activeRevisionId),
          revisions,
          affect: affect().snapshot(persona.personaId),
          experiments: affect().listExperiments(persona.personaId),
        };
      });
    },
    "personas.affect.impulse": ({ params, respond, client }) => {
      if (!Value.Check(PersonasAffectImpulseParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.affect.impulse params"),
        );
      }
      handle(respond, () =>
        affect().appendImpulse({
          ...params,
          source: "operator",
          actorId: actorId(client),
        }),
      );
    },
    "personas.experiments.propose": ({ params, respond, client }) => {
      if (!Value.Check(PersonasExperimentsProposeParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.experiments.propose params"),
        );
      }
      handle(respond, () => ({
        experiment: affect().proposeExperiment({
          ...params,
          proposerId: actorId(client),
        }),
      }));
    },
    "personas.experiments.accept": ({ params, respond, context, client }) => {
      if (!Value.Check(PersonasExperimentsAcceptParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.experiments.accept params"),
        );
      }
      handle(respond, () => {
        const result = affect().acceptExperiment({
          ...params,
          actorId: actorId(client),
          configuredAgentIds: configured(context),
        });
        context.broadcast(
          "persona.changed",
          {
            action: "revise",
            personaId: result.persona.personaId,
            status: result.persona.status,
            recordRevision: result.persona.recordRevision,
            activeRevisionId: result.persona.activeRevisionId,
          },
          { dropIfSlow: true },
        );
        return {
          ...result,
          persona: projectPersonaWithVoice(context.getRuntimeConfig(), result.persona),
        };
      });
    },
    "personas.create": ({ params, respond, context, client }) => {
      if (!Value.Check(PersonasCreateParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.create params"),
        );
      handle(respond, () => {
        const persona = repository.create({
          ...params,
          actorId: actorId(client),
          authorId: actorId(client),
          reason: "Persona created",
          configuredAgentIds: configured(context),
        });
        context.broadcast(
          "persona.changed",
          Value.Parse(PersonaChangedEventSchema, {
            action: "create",
            personaId: persona.personaId,
            status: persona.status,
            recordRevision: persona.recordRevision,
            activeRevisionId: persona.activeRevisionId,
          }),
          { dropIfSlow: true },
        );
        return { persona: projectPersonaWithVoice(context.getRuntimeConfig(), persona) };
      });
    },
    "personas.update": ({ params, respond, context, client }) => {
      if (!Value.Check(PersonasUpdateParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.update params"),
        );
      handle(respond, () => {
        const persona = repository.update({
          ...params,
          ...params.metadata,
          actorId: actorId(client),
          configuredAgentIds: configured(context),
        });
        context.broadcast(
          "persona.changed",
          {
            action: "update",
            personaId: persona.personaId,
            status: persona.status,
            recordRevision: persona.recordRevision,
            activeRevisionId: persona.activeRevisionId,
          },
          { dropIfSlow: true },
        );
        return { persona: projectPersonaWithVoice(context.getRuntimeConfig(), persona) };
      });
    },
    "personas.revise": ({ params, respond, context, client }) => {
      if (!Value.Check(PersonasReviseParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.revise params"),
        );
      handle(respond, () => {
        const result = repository.revise({
          ...params,
          actorId: actorId(client),
          authorId: actorId(client),
          configuredAgentIds: configured(context),
        });
        context.broadcast(
          "persona.changed",
          {
            action: "revise",
            personaId: result.persona.personaId,
            status: result.persona.status,
            recordRevision: result.persona.recordRevision,
            activeRevisionId: result.persona.activeRevisionId,
          },
          { dropIfSlow: true },
        );
        return {
          ...result,
          persona: projectPersonaWithVoice(context.getRuntimeConfig(), result.persona),
        };
      });
    },
    "personas.archive": ({ params, respond, context, client }) =>
      lifecycle(params, respond, context, client, "archived"),
    "personas.restore": ({ params, respond, context, client }) =>
      lifecycle(params, respond, context, client, "active"),
    "personas.delete": ({ params, respond, client, context }) => {
      if (!Value.Check(PersonasLifecycleParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.delete params"),
        );
      handle(respond, () => {
        const result = repository.delete({ ...params, actorId: actorId(client) });
        context.broadcast(
          "persona.changed",
          {
            action: "delete",
            personaId: result.personaId,
            recordRevision: params.expectedRevision,
          },
          { dropIfSlow: true },
        );
        return result;
      });
    },
    "personas.selection.get": ({ params, respond }) => {
      if (!Value.Check(PersonasSelectionGetParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.selection.get params"),
        );
      handle(respond, () => ({ selection: repository.getSelection(params.sessionKey) }));
    },
    "personas.selection.set": ({ params, respond, context, client }) => {
      if (!Value.Check(PersonasSelectionSetParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.selection.set params"),
        );
      handle(respond, () => {
        const selection = repository.setSelection({
          ...params,
          actorId: actorId(client),
          configuredAgentIds: configured(context),
        });
        context.broadcast(
          "persona.selection.changed",
          Value.Parse(PersonaSelectionChangedEventSchema, {
            action: selection ? "set" : "clear",
            sessionKey: params.sessionKey,
            ...(selection ? { personaId: selection.personaId } : {}),
            recordRevision: selection?.recordRevision ?? 0,
          }),
          { dropIfSlow: true },
        );
        return { selection };
      });
    },
    "personas.history": ({ params, respond }) => {
      if (!Value.Check(PersonasHistoryParamsSchema, params))
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.history params"),
        );
      handle(respond, () => {
        const transitions = repository.history(params.personaId, params.cursor, params.limit);
        return {
          transitions,
          ...(transitions.length === (params.limit ?? 50)
            ? { nextCursor: transitions.at(-1)?.sequence }
            : {}),
        };
      });
    },
    "personas.cognition.list": ({ params, respond, context }) => {
      if (!Value.Check(PersonasCognitionListParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.cognition.list params"),
        );
      }
      handle(respond, () => {
        repository.get(params.personaId, configured(context));
        return {
          opportunities: cognitiveOpportunityRepository.list(params.personaId, params.limit),
        };
      });
    },
    "personas.cognition.start": ({ params, respond, context }) => {
      if (!Value.Check(PersonasCognitionStartParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.cognition.start params"),
        );
      }
      handle(respond, () => {
        const persona = repository.get(params.personaId, configured(context));
        if (persona.status !== "active") {
          throw new CognitiveOpportunityValidationError("archived Personas cannot reflect");
        }
        const sessionKey = toAgentStoreSessionKey({
          agentId: persona.primaryAgentId,
          requestKey: params.sessionKey,
        });
        let opportunity = cognitiveOpportunityRepository.create({
          opportunityId: randomUUID(),
          personaId: persona.personaId,
          agentId: persona.primaryAgentId,
          sessionKey,
          source: params.source ?? "explicit",
          idempotencyKey: params.idempotencyKey,
          output: params.output,
        });
        if (opportunity.taskFlowId || opportunity.status !== "queued") {
          return { opportunity };
        }
        const flow = createManagedTaskFlow({
          ownerKey: `persona:${persona.personaId}:cognition`,
          controllerId: "core/persona-cognition",
          status: "running",
          goal: `Reflect for ${persona.displayName}`,
          currentStep: params.output ? "review_output" : "queue_dreaming",
          stateJson: {
            kind: "persona_cognitive_opportunity",
            opportunityId: opportunity.opportunityId,
            personaId: persona.personaId,
            ...(params.output ? { outputKind: params.output.kind } : {}),
          },
        });
        if (!flow) {
          opportunity = cognitiveOpportunityRepository.update(
            opportunity.opportunityId,
            opportunity.recordRevision,
            { status: "failed" },
          );
          return { opportunity };
        }
        opportunity = cognitiveOpportunityRepository.update(
          opportunity.opportunityId,
          opportunity.recordRevision,
          { status: "running", taskFlowId: flow.flowId },
        );

        if (!params.output) {
          const wake = context.cron.wake({
            mode: "now",
            text: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
            agentId: persona.primaryAgentId,
          });
          if (!wake.ok) {
            failFlow({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              currentStep: "dreaming_wake_failed",
            });
            opportunity = cognitiveOpportunityRepository.update(
              opportunity.opportunityId,
              opportunity.recordRevision,
              { status: "failed" },
            );
            return { opportunity };
          }
          finishFlow({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            currentStep: "dreaming_queued",
          });
          opportunity = cognitiveOpportunityRepository.update(
            opportunity.opportunityId,
            opportunity.recordRevision,
            {
              status: "completed",
              output: {
                kind: "no_op",
                summary: "Queued the Persona's backing Agent for its native Dreams cycle.",
              },
            },
          );
          return { opportunity };
        }

        if (!requiresCognitiveOutputApproval(params.output.kind)) {
          finishFlow({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            currentStep: "output_recorded",
          });
          opportunity = cognitiveOpportunityRepository.update(
            opportunity.opportunityId,
            opportunity.recordRevision,
            { status: "completed", output: params.output },
          );
          return { opportunity };
        }

        const inputService = new WorkInputService(undefined, createGatewayWorkInputOwner(context));
        const approval = inputService.create({
          kind: "approval",
          sessionKey,
          prompt: `Review ${params.output.kind.replaceAll("_", " ")} from ${persona.displayName}`,
          description: params.output.summary,
          creator: { type: "system", label: "Persona cognition" },
          flow: { flowId: flow.flowId, expectedRevision: flow.revision },
          decisions: ["approve", "reject"],
        });
        opportunity = cognitiveOpportunityRepository.update(
          opportunity.opportunityId,
          opportunity.recordRevision,
          {
            status: "waiting_review",
            output: params.output,
            approvalRequestId: approval.request.id,
          },
        );
        return { opportunity };
      });
    },
    "personas.memory.list": ({ params, respond }) => {
      if (!Value.Check(PersonasMemoryListParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.memory.list params"),
        );
      }
      handle(respond, () => ({
        memories: memoryRepository.list(params.personaId, {
          query: params.query,
          includeInvalid: params.includeInvalid,
        }),
      }));
    },
    "personas.memory.create": ({ params, respond, client }) => {
      if (!Value.Check(PersonasMemoryCreateParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.memory.create params"),
        );
      }
      handle(respond, () => ({
        memory: memoryRepository.create(params.personaId, {
          ...params.memory,
          provenance: {
            actorId: actorId(client),
            source: "operator",
          },
        }),
      }));
    },
    "personas.memory.correct": ({ params, respond, client }) => {
      if (!Value.Check(PersonasMemoryCorrectParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.memory.correct params"),
        );
      }
      handle(respond, () => ({
        memory: memoryRepository.correct(
          params.personaId,
          params.recordId,
          params.expectedRevision,
          {
            ...params.memory,
            provenance: {
              actorId: actorId(client),
              source: "operator",
            },
          },
        ),
      }));
    },
    "personas.memory.delete": ({ params, respond }) => {
      if (!Value.Check(PersonasMemoryDeleteParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.memory.delete params"),
        );
      }
      handle(respond, () => {
        return memoryRepository.delete(
          params.personaId,
          params.recordId,
          params.expectedRevision,
          params.idempotencyKey,
        );
      });
    },
    "personas.memory.export": ({ params, respond }) => {
      if (!Value.Check(PersonasMemoryExportParamsSchema, params)) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid personas.memory.export params"),
        );
      }
      handle(respond, () => ({
        filename: `${params.personaId}-memory.json`,
        json: memoryRepository.exportJson(params.personaId),
      }));
    },
  };

  function requiresCognitiveOutputApproval(kind: CognitiveOutputKind): boolean {
    return kind !== "internal_memo" && kind !== "no_op";
  }

  function lifecycle(
    params: unknown,
    respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
    context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
    client: GatewayClient | null,
    status: "active" | "archived",
  ) {
    if (!Value.Check(PersonasLifecycleParamsSchema, params))
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid Persona lifecycle params"),
      );
    handle(respond, () => {
      const { persona, clearedSessionKeys } = repository.setStatus({
        ...params,
        status,
        actorId: actorId(client),
        configuredAgentIds: configured(context),
      });
      const action = status === "archived" ? "archive" : "restore";
      context.broadcast(
        "persona.changed",
        {
          action,
          personaId: persona.personaId,
          status,
          recordRevision: persona.recordRevision,
          activeRevisionId: persona.activeRevisionId,
        },
        { dropIfSlow: true },
      );
      for (const sessionKey of clearedSessionKeys) {
        context.broadcast(
          "persona.selection.changed",
          Value.Parse(PersonaSelectionChangedEventSchema, {
            action: "clear",
            sessionKey,
            recordRevision: 0,
          }),
          { dropIfSlow: true },
        );
      }
      return { persona: projectPersonaWithVoice(context.getRuntimeConfig(), persona) };
    });
  }
}

export const personaHandlers = createPersonaHandlers();
