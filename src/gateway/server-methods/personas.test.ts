import { describe, expect, it, vi } from "vitest";
import type { PersonaRepository } from "../../personas/repository.js";
import { PersonaConflictError, PersonaValidationError } from "../../personas/types.js";
import { createPersonaHandlers } from "./personas.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const persona = {
  personaId: "persona-1",
  slug: "lucy",
  displayName: "Lucy",
  description: "Companion",
  status: "active" as const,
  primaryAgentId: "main",
  allowedDelegateAgentIds: ["delegate"],
  activeRevisionId: "revision-1",
  recordRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  missingAgentIds: [],
};
const projectedPersona = { ...persona, voiceBinding: { status: "unbound" as const } };
const revision = {
  identity: "A careful collaborator.",
  relationship: "A trusted working partner.",
  communicationStyle: "Clear and concise.",
  behaviorGuidance: "Ask only when authority is required.",
  traits: { warmth: 0.8, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(() => [persona]),
    get: vi.fn(() => persona),
    getRevision: vi.fn(() => ({
      revisionId: "revision-1",
      personaId: "persona-1",
      revisionNumber: 1,
      content: revision,
      authorId: "device:test",
      reason: "Initial revision",
      createdAt: 1,
    })),
    listRevisions: vi.fn(() => []),
    create: vi.fn(() => persona),
    update: vi.fn(() => persona),
    revise: vi.fn(),
    setStatus: vi.fn(() => ({ persona, clearedSessionKeys: [] })),
    delete: vi.fn(() => ({ deleted: true, personaId: "persona-1" })),
    getSelection: vi.fn(() => undefined),
    setSelection: vi.fn(() => undefined),
    history: vi.fn(() => []),
    ...overrides,
  } as unknown as PersonaRepository;
}

async function invoke(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const broadcast = vi.fn();
  await handlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: { connect: { device: { id: "test-device" } } },
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }, { id: "delegate" }] },
      }),
      broadcast,
    },
  } as unknown as GatewayRequestHandlerOptions);
  return { respond, broadcast };
}

describe("Persona gateway handlers", () => {
  it("rejects invalid input before repository mutation", async () => {
    const create = vi.fn();
    const { respond } = await invoke(
      createPersonaHandlers({ repository: repository({ create }) }),
      "personas.create",
      { slug: "lucy", unknown: true },
    );

    expect(create).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("maps validation errors without broadcasting", async () => {
    const create = vi.fn(() => {
      throw new PersonaValidationError("Agent is not configured: missing");
    });
    const { respond, broadcast } = await invoke(
      createPersonaHandlers({ repository: repository({ create }) }),
      "personas.create",
      {
        slug: "lucy",
        displayName: "Lucy",
        description: "Companion",
        primaryAgentId: "main",
        allowedDelegateAgentIds: [],
        revision,
        idempotencyKey: "create-lucy",
      },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not configured") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts bounded metadata only after a committed create", async () => {
    const { respond, broadcast } = await invoke(
      createPersonaHandlers({ repository: repository() }),
      "personas.create",
      {
        slug: "lucy",
        displayName: "Lucy",
        description: "Companion",
        primaryAgentId: "main",
        allowedDelegateAgentIds: ["delegate"],
        revision,
        idempotencyKey: "create-lucy",
      },
    );

    expect(respond).toHaveBeenCalledWith(true, { persona: projectedPersona }, undefined);
    expect(broadcast).toHaveBeenCalledWith(
      "persona.changed",
      {
        action: "create",
        personaId: "persona-1",
        status: "active",
        recordRevision: 1,
        activeRevisionId: "revision-1",
      },
      { dropIfSlow: true },
    );
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("behaviorGuidance");
  });

  it("maps selection CAS conflicts and emits no event", async () => {
    const setSelection = vi.fn(() => {
      throw new PersonaConflictError("stale Persona selection revision");
    });
    const { respond, broadcast } = await invoke(
      createPersonaHandlers({ repository: repository({ setSelection }) }),
      "personas.selection.set",
      {
        sessionKey: "agent:main:main",
        personaId: "persona-1",
        expectedRevision: 2,
        idempotencyKey: "select-lucy",
      },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("stale") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts a bounded selection event after commit", async () => {
    const selection = {
      sessionKey: "agent:main:main",
      personaId: "persona-1",
      recordRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const { broadcast } = await invoke(
      createPersonaHandlers({ repository: repository({ setSelection: vi.fn(() => selection) }) }),
      "personas.selection.set",
      {
        sessionKey: "agent:main:main",
        personaId: "persona-1",
        expectedRevision: 0,
        idempotencyKey: "select-lucy",
      },
    );

    expect(broadcast).toHaveBeenCalledWith(
      "persona.selection.changed",
      {
        action: "set",
        sessionKey: "agent:main:main",
        personaId: "persona-1",
        recordRevision: 1,
      },
      { dropIfSlow: true },
    );
  });

  it("emits bounded selection clear events after archive commits", async () => {
    const setStatus = vi.fn(() => ({
      persona: { ...persona, status: "archived" as const, recordRevision: 2 },
      clearedSessionKeys: ["agent:main:first", "agent:main:second"],
    }));
    const { respond, broadcast } = await invoke(
      createPersonaHandlers({ repository: repository({ setStatus }) }),
      "personas.archive",
      {
        personaId: "persona-1",
        expectedRevision: 1,
        idempotencyKey: "archive-lucy",
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      { persona: expect.objectContaining({ status: "archived", recordRevision: 2 }) },
      undefined,
    );
    expect(broadcast.mock.calls).toEqual([
      [
        "persona.changed",
        {
          action: "archive",
          personaId: "persona-1",
          status: "archived",
          recordRevision: 2,
          activeRevisionId: "revision-1",
        },
        { dropIfSlow: true },
      ],
      [
        "persona.selection.changed",
        { action: "clear", sessionKey: "agent:main:first", recordRevision: 0 },
        { dropIfSlow: true },
      ],
      [
        "persona.selection.changed",
        { action: "clear", sessionKey: "agent:main:second", recordRevision: 0 },
        { dropIfSlow: true },
      ],
    ]);
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("behaviorGuidance");
  });

  it("maps duplicate slug conflicts without broadcasting", async () => {
    const create = vi.fn(() => {
      throw new PersonaConflictError("Persona slug is already in use: lucy");
    });
    const { respond, broadcast } = await invoke(
      createPersonaHandlers({ repository: repository({ create }) }),
      "personas.create",
      {
        slug: "lucy",
        displayName: "Lucy",
        description: "Companion",
        primaryAgentId: "main",
        allowedDelegateAgentIds: [],
        revision,
        idempotencyKey: "duplicate-lucy",
      },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already in use") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
});
