import { PersonaConflictError, PersonaRepository } from "./repository.js";
import type { PersonaRevisionContent } from "./types.js";

export type PersonaRunAttribution = {
  personaId: string;
  personaRevisionId: string;
  displayName: string;
};

export type PersonaRunContext = PersonaRunAttribution & { systemPrompt: string };

export function buildPersonaSystemPrompt(params: {
  attribution: PersonaRunAttribution;
  content: PersonaRevisionContent;
}): string {
  const traits = Object.entries(params.content.traits)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  return [
    `Persona ${params.attribution.displayName} (${params.attribution.personaId}, revision ${params.attribution.personaRevisionId}).`,
    `Identity: ${params.content.identity}`,
    `Relationship: ${params.content.relationship}`,
    `Communication style: ${params.content.communicationStyle}`,
    `Behavior guidance: ${params.content.behaviorGuidance}`,
    `Traits: ${traits}.`,
    "Persona identity does not change Agent, model, tools, permissions, workspace, or runtime authority.",
  ].join("\n");
}

export function resolvePersonaRunContext(params: {
  sessionKey: string;
  agentId: string;
  configuredAgentIds: ReadonlySet<string>;
  repository?: PersonaRepository;
}): PersonaRunContext | undefined {
  const repository = params.repository ?? new PersonaRepository();
  const selection = repository.getSelection(params.sessionKey);
  if (!selection) return undefined;
  const persona = repository.get(selection.personaId, params.configuredAgentIds);
  if (persona.status !== "active") throw new PersonaConflictError("Selected Persona is archived");
  if (persona.missingAgentIds.length > 0) {
    throw new PersonaConflictError(
      `Selected Persona has missing Agent references: ${persona.missingAgentIds.join(", ")}`,
    );
  }
  if (persona.primaryAgentId !== params.agentId) {
    throw new PersonaConflictError(
      `Selected Persona requires Agent ${persona.primaryAgentId}, not ${params.agentId}`,
    );
  }
  const activeRevision = repository.getRevision(persona.activeRevisionId);
  const attribution = {
    personaId: persona.personaId,
    personaRevisionId: activeRevision.revisionId,
    displayName: persona.displayName,
  };
  return {
    ...attribution,
    systemPrompt: buildPersonaSystemPrompt({ attribution, content: activeRevision.content }),
  };
}
