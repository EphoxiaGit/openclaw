import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PersonasGetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { PersonasPage } from "./personas-page.ts";

const persona = {
  personaId: "persona-lucy",
  slug: "lucy",
  displayName: "Lucy",
  description: "A thoughtful collaborator.",
  status: "active" as const,
  primaryAgentId: "main",
  allowedDelegateAgentIds: ["research"],
  activeRevisionId: "revision-1",
  recordRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  missingAgentIds: [],
  voiceBinding: { status: "unbound" as const },
  embodimentBinding: { status: "unbound" as const },
};

const detail: PersonasGetResult = {
  persona,
  activeRevision: {
    revisionId: "revision-1",
    personaId: persona.personaId,
    revisionNumber: 1,
    content: {
      identity: "Lucy",
      relationship: "Trusted collaborator",
      communicationStyle: "Clear and warm",
      behaviorGuidance: "Preserve user intent",
      traits: { warmth: 0.7, directness: 0.7, playfulness: 0.2, formality: 0.4 },
    },
    authorId: "operator",
    reason: "Initial revision",
    createdAt: 1,
  },
  revisions: [],
  affect: {
    personaId: persona.personaId,
    personaRevisionId: "revision-1",
    evaluatedAt: 1,
    baseline: {
      energy: 5000,
      focus: 7000,
      warmth: 7000,
      playfulness: 2000,
    },
    values: {
      energy: 6000,
      focus: 7000,
      warmth: 7000,
      playfulness: 2000,
    },
    impulseLogDigest: "a".repeat(64),
    projection: {
      tone: "focused",
      pacing: "steady",
      ttsExpression: {
        energy: 6000,
        warmth: 7000,
        urgency: 2500,
        pace: 5500,
        emphasis: 5000,
        playfulness: 2000,
      },
      airiExpression: "emotion.curious",
    },
    recentImpulses: [],
  },
  experiments: [],
};

describe("PersonasPage", () => {
  it("renders inspectable affect and allowlisted experiment controls", () => {
    const page = new PersonasPage();
    const container = document.createElement("div");
    const template = (
      page as unknown as {
        renderAffect: (value: PersonasGetResult) => ReturnType<typeof page.render>;
      }
    ).renderAffect(detail);

    render(template, container);

    expect(container.textContent).toContain("Bounded affect");
    expect(container.textContent).toContain("AIRI expression");
    expect(container.textContent).toContain("Persona experiments");
    expect(container.querySelector('select[name="field"] option[value="traits.warmth"]')).not.toBe(
      null,
    );
  });

  it("keeps a ready current binding selectable when discovery omits it", () => {
    const page = new PersonasPage();
    const container = document.createElement("div");
    const readyDetail: PersonasGetResult = {
      ...detail,
      persona: {
        ...detail.persona,
        voiceBinding: { status: "ready", ttsPersonaId: "lucy-voice", provider: "mock" },
      },
    };
    const template = (
      page as unknown as {
        renderVoice: (value: PersonasGetResult) => ReturnType<typeof page.render>;
      }
    ).renderVoice(readyDetail);

    render(template, container);

    const current = container.querySelector<HTMLOptionElement>('option[value="lucy-voice"]');
    expect(current?.selected).toBe(true);
    expect(current?.textContent).toContain("current binding");
  });

  it("uses the same selector, tabs, and contained panel structure as Agents", async () => {
    const page = new PersonasPage();
    const navigate = vi.fn();
    (page as unknown as { context: ApplicationContext }).context = {
      personas: {
        state: { list: { personas: [persona] }, loading: false, error: null },
        subscribe: () => () => undefined,
        refresh: vi.fn(async () => ({ personas: [persona] })),
        get: vi.fn(async () => detail),
      },
      agents: {
        state: {
          agentsList: {
            agents: [
              { id: "main", name: "Main" },
              { id: "research", name: "Research" },
            ],
          },
        },
        subscribe: () => () => undefined,
        ensureList: vi.fn(async () => undefined),
      },
      gateway: { snapshot: { client: null }, subscribe: () => () => undefined },
      navigate,
    } as unknown as ApplicationContext;

    document.body.append(page);
    try {
      await vi.waitFor(() => {
        expect(page.querySelector(".agent-tabs")).not.toBeNull();
      });

      expect(page.querySelector(".agents-toolbar .agents-select")).not.toBeNull();
      expect(page.querySelectorAll(".agent-tab")).toHaveLength(8);
      expect(page.querySelector(".agents-main > .card")).not.toBeNull();
      expect(page.querySelector(".personas-page__setup-grid")).toBeNull();
      expect(page.textContent).not.toContain("Create Lucy Persona");
      expect(page.textContent).toContain("Lifecycle");

      const identityTab = Array.from(page.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
        (tab) => tab.textContent?.includes("Identity & Personality"),
      );
      identityTab?.click();
      await page.updateComplete;
      expect(page.querySelector('textarea[name="behaviorGuidance"]')).not.toBeNull();

      const voiceTab = Array.from(page.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
        (tab) => tab.textContent?.includes("Voice"),
      );
      voiceTab?.click();
      await page.updateComplete;
      expect(page.textContent).toContain("Named voice profiles are configured in Settings");
      expect(page.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
      const configureVoice = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.includes("Configure voice settings"),
      );
      configureVoice?.click();
      expect(navigate).toHaveBeenCalledWith("communications", {
        search: "?section=messages&subsection=tts",
      });

      const embodimentTab = Array.from(page.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
        (tab) => tab.textContent?.includes("Embodiment"),
      );
      embodimentTab?.click();
      await page.updateComplete;
      expect(page.textContent).toContain("AIRI renders these references");
      expect(page.querySelector('input[name="manifestRef"]')).not.toBeNull();
    } finally {
      page.remove();
    }
  });

  it("renders governed Persona memory controls", () => {
    const page = new PersonasPage();
    const container = document.createElement("div");
    const internal = page as unknown as {
      memories: Array<Record<string, unknown>>;
      renderMemory: () => ReturnType<typeof page.render>;
    };
    internal.memories = [
      {
        recordId: "memory-1",
        personaId: persona.personaId,
        key: "favorite-color",
        content: "Blue",
        confidence: 0.8,
        sensitivity: "normal",
        validFrom: 1,
        conflictStatus: "conflicted",
        recordRevision: 2,
        updatedAt: 2,
      },
    ];

    render(internal.renderMemory(), container);

    expect(container.textContent).toContain("Persona Memory");
    expect(container.textContent).toContain("favorite-color");
    expect(container.querySelector('select[name="conflictStatus"]')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')?.textContent).toContain("Remember");
    expect(container.textContent).toContain("Export JSON");
  });

  it("ignores a stale Persona response after the selection changes", async () => {
    const otherPersona = {
      ...persona,
      personaId: "persona-other",
      slug: "other",
      displayName: "Other",
    };
    const otherDetail = { ...detail, persona: otherPersona };
    let resolveLucy: ((value: PersonasGetResult) => void) | undefined;
    let resolveOther: ((value: PersonasGetResult) => void) | undefined;
    const page = new PersonasPage();
    (page as unknown as { context: ApplicationContext }).context = {
      personas: {
        get: vi.fn(
          (personaId: string) =>
            new Promise<PersonasGetResult>((resolve) => {
              if (personaId === persona.personaId) {
                resolveLucy = resolve;
              } else {
                resolveOther = resolve;
              }
            }),
        ),
      },
      gateway: { snapshot: { client: null } },
    } as unknown as ApplicationContext;
    const internal = page as unknown as {
      select: (personaId: string) => Promise<void>;
      detail: PersonasGetResult | null;
    };

    const first = internal.select(persona.personaId);
    const second = internal.select(otherPersona.personaId);
    resolveOther?.(otherDetail);
    await second;
    resolveLucy?.(detail);
    await first;

    expect(internal.detail?.persona.personaId).toBe(otherPersona.personaId);
  });

  it("uses the Persona's primary Agent for voice discovery and preview", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tts.personas") {
        return { personas: [{ id: "lucy-voice", provider: "mock" }] };
      }
      return {
        audioBase64: "AQID",
        provider: "mock",
        mimeType: "audio/mpeg",
      };
    });
    const page = new PersonasPage();
    (page as unknown as { context: ApplicationContext }).context = {
      personas: { get: vi.fn(async () => detail) },
      gateway: { snapshot: { client: { request } } },
    } as unknown as ApplicationContext;
    const internal = page as unknown as {
      select: (personaId: string) => Promise<void>;
      previewVoice: (event: SubmitEvent) => Promise<void>;
      detail: PersonasGetResult | null;
    };

    await internal.select(persona.personaId);
    internal.detail = {
      ...detail,
      persona: {
        ...detail.persona,
        voiceBinding: { status: "ready", ttsPersonaId: "lucy-voice", provider: "mock" },
      },
    };
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.name = "preview";
    input.value = "Hello.";
    form.append(input);
    await internal.previewVoice({ preventDefault: vi.fn(), currentTarget: form } as never);

    expect(request).toHaveBeenCalledWith("tts.personas", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("tts.speak", {
      text: "Hello.",
      persona: "lucy-voice",
      agentId: "main",
    });
  });
});
