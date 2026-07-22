import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  PersonasCreateParams,
  PersonasGetResult,
  PersonasListResult,
  PersonasSelectionSetParams,
} from "../../api/types.ts";

type GatewaySnapshot = { client: GatewayBrowserClient | null; connected: boolean };
type PersonaGateway = {
  readonly snapshot: GatewaySnapshot;
  subscribe: (listener: (snapshot: GatewaySnapshot) => void) => () => void;
  subscribeEvents: (listener: (event: { event: string; payload: unknown }) => void) => () => void;
};

export type PersonaCapabilityState = {
  list: PersonasListResult | null;
  loading: boolean;
  error: string | null;
};

export type PersonaCapability = {
  readonly state: PersonaCapabilityState;
  refresh: (includeArchived?: boolean) => Promise<PersonasListResult | null>;
  get: (personaId: string) => Promise<PersonasGetResult>;
  create: (params: PersonasCreateParams) => Promise<PersonasGetResult["persona"]>;
  update: (params: Record<string, unknown>) => Promise<PersonasGetResult["persona"]>;
  revise: (params: Record<string, unknown>) => Promise<PersonasGetResult>;
  lifecycle: (
    action: "archive" | "restore" | "delete",
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  getSelection: (sessionKey: string) => Promise<unknown>;
  setSelection: (params: PersonasSelectionSetParams) => Promise<unknown>;
  subscribe: (listener: (state: PersonaCapabilityState) => void) => () => void;
  dispose: () => void;
};

export function createPersonaCapability(gateway: PersonaGateway): PersonaCapability {
  const state: PersonaCapabilityState = { list: null, loading: false, error: null };
  const listeners = new Set<(state: PersonaCapabilityState) => void>();
  const emit = () => listeners.forEach((listener) => listener(state));
  let generation = 0;
  const client = () => {
    const snapshot = gateway.snapshot;
    if (!snapshot.connected || !snapshot.client) throw new Error("Gateway is not connected");
    return snapshot.client;
  };
  const refresh = async (includeArchived = true) => {
    const current = ++generation;
    state.loading = true;
    state.error = null;
    emit();
    try {
      const result = await client().request<PersonasListResult>("personas.list", {
        includeArchived,
      });
      if (current === generation) state.list = result;
      return result;
    } catch (error) {
      if (current === generation)
        state.error = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      if (current === generation) {
        state.loading = false;
        emit();
      }
    }
  };
  const stopGateway = gateway.subscribe((snapshot) => {
    if (snapshot.connected) void refresh();
    else {
      generation += 1;
      state.list = null;
      emit();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event === "persona.changed" || event.event === "persona.selection.changed") {
      void refresh();
    }
  });
  return {
    state,
    refresh,
    get: (personaId) => client().request("personas.get", { personaId }),
    create: async (params) =>
      (await client().request<{ persona: PersonasGetResult["persona"] }>("personas.create", params))
        .persona,
    update: async (params) =>
      (await client().request<{ persona: PersonasGetResult["persona"] }>("personas.update", params))
        .persona,
    revise: (params) => client().request("personas.revise", params),
    lifecycle: (action, params) => client().request(`personas.${action}`, params),
    getSelection: (sessionKey) => client().request("personas.selection.get", { sessionKey }),
    setSelection: (params) => client().request("personas.selection.set", params),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      generation += 1;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}
