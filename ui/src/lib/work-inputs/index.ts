import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WorkInputRequest, WorkInputResponse } from "../../api/types.ts";

type GatewaySnapshot = { client: GatewayBrowserClient | null; connected: boolean };
type WorkInputGateway = {
  readonly snapshot: GatewaySnapshot;
  subscribeEvents: (listener: (event: { event: string; payload: unknown }) => void) => () => void;
};
export type WorkInputSessionState = {
  requests: WorkInputRequest[];
  loading: boolean;
  error: string | null;
};
export type WorkInputCapabilityState = {
  sessions: Map<string, WorkInputSessionState>;
};
export type WorkInputCapability = {
  readonly state: WorkInputCapabilityState;
  forSession: (sessionKey: string) => WorkInputSessionState;
  refresh: (sessionKey: string) => Promise<void>;
  resolve: (request: WorkInputRequest, response: WorkInputResponse) => Promise<void>;
  cancel: (request: WorkInputRequest) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

const EMPTY_SESSION_STATE: WorkInputSessionState = {
  requests: [],
  loading: false,
  error: null,
};

function requestedSessionKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const request = (payload as { request?: unknown }).request;
  if (!request || typeof request !== "object") {
    return undefined;
  }
  const sessionKey = (request as { sessionKey?: unknown }).sessionKey;
  return typeof sessionKey === "string" && sessionKey ? sessionKey : undefined;
}

function changedRequestId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId ? requestId : undefined;
}

export function createWorkInputCapability(gateway: WorkInputGateway): WorkInputCapability {
  const state: WorkInputCapabilityState = { sessions: new Map() };
  const listeners = new Set<() => void>();
  const generations = new Map<string, number>();
  const emit = () => listeners.forEach((listener) => listener());
  const client = () => {
    if (!gateway.snapshot.connected || !gateway.snapshot.client) {
      throw new Error("Gateway is not connected");
    }
    return gateway.snapshot.client;
  };
  const forSession = (sessionKey: string) => state.sessions.get(sessionKey) ?? EMPTY_SESSION_STATE;
  const refresh = async (sessionKey: string) => {
    const current = (generations.get(sessionKey) ?? 0) + 1;
    generations.set(sessionKey, current);
    state.sessions.set(sessionKey, {
      ...forSession(sessionKey),
      loading: true,
      error: null,
    });
    emit();
    try {
      const result = await client().request<{ requests: WorkInputRequest[] }>("work.inputs.list", {
        sessionKey,
        status: "pending",
      });
      if (generations.get(sessionKey) === current) {
        state.sessions.set(sessionKey, {
          requests: result.requests,
          loading: false,
          error: null,
        });
      }
    } catch (error) {
      if (generations.get(sessionKey) === current) {
        state.sessions.set(sessionKey, {
          ...forSession(sessionKey),
          loading: false,
          error: String(error),
        });
      }
    } finally {
      if (generations.get(sessionKey) === current) {
        const session = forSession(sessionKey);
        if (session.loading) {
          state.sessions.set(sessionKey, { ...session, loading: false });
        }
        emit();
      }
    }
  };
  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event === "work.input.requested") {
      const sessionKey = requestedSessionKey(event.payload);
      if (sessionKey) {
        void refresh(sessionKey);
      }
      return;
    }
    if (event.event === "work.input.changed") {
      const requestId = changedRequestId(event.payload);
      if (!requestId) {
        return;
      }
      for (const [sessionKey, session] of state.sessions) {
        if (session.requests.some((request) => request.id === requestId)) {
          void refresh(sessionKey);
        }
      }
    }
  });
  return {
    state,
    forSession,
    refresh,
    async resolve(request, response) {
      await client().request("work.inputs.resolve", {
        requestId: request.id,
        expectedRevision: request.revision,
        idempotencyKey: crypto.randomUUID(),
        response,
      });
      await refresh(request.sessionKey);
    },
    async cancel(request) {
      await client().request("work.inputs.cancel", {
        requestId: request.id,
        expectedRevision: request.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh(request.sessionKey);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      generations.clear();
      stopEvents();
      listeners.clear();
    },
  };
}
