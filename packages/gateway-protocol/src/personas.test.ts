import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PersonaChangedEventSchema,
  PersonasCognitionStartParamsSchema,
  PersonasCreateParamsSchema,
  PersonasListResultSchema,
} from "./schema/personas.js";

describe("Persona gateway schemas", () => {
  it("accepts bounded creation input and rejects unknown properties", () => {
    const input = {
      slug: "lucy",
      displayName: "Lucy",
      description: "Companion",
      primaryAgentId: "main",
      allowedDelegateAgentIds: ["delegate"],
      embodimentBinding: { modelRef: "model.lucy.v1" },
      revision: {
        identity: "A careful collaborator.",
        relationship: "A trusted working partner.",
        communicationStyle: "Clear and concise.",
        behaviorGuidance: "Ask only when authority is required.",
        traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
      },
      idempotencyKey: "create-lucy",
    };
    expect(Value.Check(PersonasCreateParamsSchema, input)).toBe(true);
    expect(Value.Check(PersonasCreateParamsSchema, { ...input, secret: "no" })).toBe(false);
    expect(
      Value.Check(PersonasCreateParamsSchema, {
        ...input,
        embodimentBinding: { modelRef: "https://example.test/lucy.vrm" },
      }),
    ).toBe(false);
  });

  it("keeps summaries and change events metadata-only", () => {
    expect(Value.Check(PersonasListResultSchema, { personas: [] })).toBe(true);
    expect(
      Value.Check(PersonaChangedEventSchema, {
        action: "revise",
        personaId: "persona-1",
        status: "active",
        recordRevision: 2,
        activeRevisionId: "revision-2",
        content: "must not cross the event boundary",
      }),
    ).toBe(false);
  });

  it("accepts only closed cognitive opportunity outputs", () => {
    const input = {
      personaId: "persona-1",
      sessionKey: "agent:main:main",
      source: "explicit",
      output: { kind: "project_suggestion", summary: "Review the next milestone." },
      idempotencyKey: "reflect-1",
    };
    expect(Value.Check(PersonasCognitionStartParamsSchema, input)).toBe(true);
    expect(
      Value.Check(PersonasCognitionStartParamsSchema, {
        ...input,
        output: { kind: "execute_tool", summary: "Run it." },
      }),
    ).toBe(false);
    expect(Value.Check(PersonasCognitionStartParamsSchema, { ...input, continuous: true })).toBe(
      false,
    );
  });

  it("exposes effective named TTS binding metadata without provider credentials", () => {
    expect(
      Value.Check(PersonasListResultSchema, {
        personas: [
          {
            personaId: "persona-1",
            slug: "lucy",
            displayName: "Lucy",
            description: "Companion",
            status: "active",
            primaryAgentId: "main",
            allowedDelegateAgentIds: [],
            activeRevisionId: "revision-1",
            recordRevision: 1,
            createdAt: 1,
            updatedAt: 1,
            missingAgentIds: [],
            voiceBinding: {
              status: "ready",
              ttsPersonaId: "lucy-voice",
              provider: "elevenlabs",
              model: "multilingual-v2",
              voice: "lucy",
              providerBinding: "applied",
            },
            embodimentBinding: {
              status: "bound",
              characterRef: "character.lucy",
              manifestRef: "manifest.lucy.v1",
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
