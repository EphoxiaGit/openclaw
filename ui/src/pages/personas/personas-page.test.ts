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
};

describe("PersonasPage", () => {
  it("uses the same selector, tabs, and contained panel structure as Agents", async () => {
    const page = new PersonasPage();
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
      gateway: { snapshot: { client: null } },
    } as unknown as ApplicationContext;

    document.body.append(page);
    try {
      await vi.waitFor(() => {
        expect(page.querySelector(".agent-tabs")).not.toBeNull();
      });

      expect(page.querySelector(".agents-toolbar .agents-select")).not.toBeNull();
      expect(page.querySelectorAll(".agent-tab")).toHaveLength(4);
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
    } finally {
      page.remove();
    }
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
});
