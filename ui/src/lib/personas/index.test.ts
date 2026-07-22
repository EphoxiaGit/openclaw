import { describe, expect, it, vi } from "vitest";
import { createPersonaCapability } from "./index.ts";

describe("Persona capability", () => {
  it("reconstructs from Gateway and refetches on Persona events", async () => {
    let eventListener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const request = vi.fn(async () => ({ personas: [] }));
    const capability = createPersonaCapability({
      snapshot: { connected: true, client: { request } as never },
      subscribe: () => () => undefined,
      subscribeEvents: (listener) => {
        eventListener = listener;
        return () => undefined;
      },
    });

    await capability.refresh();
    eventListener?.({ event: "persona.changed", payload: { personaId: "persona-1" } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(capability.state.list).toEqual({ personas: [] });
    capability.dispose();
  });
});
