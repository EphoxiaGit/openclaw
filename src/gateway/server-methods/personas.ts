import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  PersonaChangedEventSchema,
  PersonaSelectionChangedEventSchema,
  PersonasCreateParamsSchema,
  PersonasGetParamsSchema,
  PersonasHistoryParamsSchema,
  PersonasLifecycleParamsSchema,
  PersonasListParamsSchema,
  PersonasReviseParamsSchema,
  PersonasSelectionGetParamsSchema,
  PersonasSelectionSetParamsSchema,
  PersonasUpdateParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/personas.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import {
  PersonaConflictError,
  PersonaNotFoundError,
  PersonaRepository,
  PersonaValidationError,
} from "../../personas/repository.js";
import { projectPersonaWithVoice } from "../../personas/voice-binding.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

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
    } else {
      throw error;
    }
  }
}

export function createPersonaHandlers(
  input: { repository?: PersonaRepository } = {},
): GatewayRequestHandlers {
  const repository = input.repository ?? new PersonaRepository();
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
  };

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
