import { describe, expect, it } from "vitest";
import type { PersonaRepository } from "./repository.js";
import { buildPersonaSystemPrompt, resolvePersonaRunContext } from "./runtime-context.js";
import { PersonaConflictError } from "./types.js";

const content = {
  identity: "A careful collaborator.",
  relationship: "A trusted partner.",
  communicationStyle: "Clear and concise.",
  behaviorGuidance: "Preserve user intent.",
  traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};

function repository(primaryAgentId = "main") {
  return {
    getSelection: () => ({ sessionKey: "agent:main:main", personaId: "persona-1" }),
    get: () => ({
      personaId: "persona-1",
      displayName: "Lucy",
      status: "active",
      primaryAgentId,
      activeRevisionId: "revision-2",
      missingAgentIds: [],
    }),
    getRevision: () => ({ revisionId: "revision-2", content }),
  } as unknown as PersonaRepository;
}

describe("Persona runtime context", () => {
  it("builds a deterministic prompt pinned to one immutable revision", () => {
    const result = resolvePersonaRunContext({
      sessionKey: "agent:main:main",
      agentId: "main",
      configuredAgentIds: new Set(["main"]),
      repository: repository(),
    });
    expect(result).toMatchObject({
      personaId: "persona-1",
      personaRevisionId: "revision-2",
      displayName: "Lucy",
    });
    expect(result?.systemPrompt).toBe(
      buildPersonaSystemPrompt({
        attribution: {
          personaId: "persona-1",
          personaRevisionId: "revision-2",
          displayName: "Lucy",
        },
        content,
      }),
    );
    expect(result?.systemPrompt).toContain(
      "does not change Agent, model, tools, permissions, workspace, or runtime authority",
    );
  });

  it("rejects a selected Persona bound to another Agent", () => {
    expect(() =>
      resolvePersonaRunContext({
        sessionKey: "agent:main:main",
        agentId: "main",
        configuredAgentIds: new Set(["main", "other"]),
        repository: repository("other"),
      }),
    ).toThrow(PersonaConflictError);
  });
});
