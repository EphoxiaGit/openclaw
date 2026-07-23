import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  createCompanionEmbodiment,
  type CompanionEmbodiment,
  type CompanionRendererCommand,
} from "../../../../src/gateway/companion-embodiment.ts";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import {
  COMPANION_CHANNEL_MESSAGE,
  COMPANION_CHANNEL_PROTOCOL,
  readCompanionAttachResult,
  readCompanionEvent,
  readCompanionRendererIntent,
  type CompanionSemanticRendererCommand,
} from "../../app/companion-stage.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { CompanionRouteData } from "./route.ts";

type FrameState = "loading" | "ready" | "unavailable";
type RuntimeState = "disabled" | "unsupported" | "attaching" | "attached" | "failed";

function isActiveState(command: CompanionRendererCommand | null): boolean {
  return (
    command?.state === "thinking" ||
    command?.state === "responding" ||
    command?.state === "speaking"
  );
}

class CompanionPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) routeData?: CompanionRouteData;
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext;

  @state() private frameState: FrameState = "loading";
  @state() private runtimeState: RuntimeState = "disabled";
  @state() private currentCommand: CompanionRendererCommand | null = null;
  private currentSemanticCommand: CompanionSemanticRendererCommand | null = null;
  @state() private cancelling = false;

  private client: GatewayBrowserClient | null = null;
  private attachedConversationId: string | null = null;
  private embodiment: CompanionEmbodiment | null = null;
  private channelPort: MessagePort | null = null;
  private lastRendererIntentSequence = 0;
  private lastSemanticSequence = 0;
  private attachGeneration = 0;
  private expiryTimer: number | undefined;
  private stopGatewaySubscription?: () => void;
  private stopGatewayEvents?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    if (!this.context) return;
    // Event delivery is installed before any attach request can register this client.
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) =>
      this.handleGatewayEvent(event),
    );
    this.stopGatewaySubscription = this.context.gateway.subscribe(() => this.syncGateway());
    this.syncGateway();
  }

  override disconnectedCallback() {
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.releaseRuntime(true, true);
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.frameState = this.routeData?.localStageEnabled ? "loading" : "unavailable";
      this.syncGateway();
    }
  }

  private frameLoaded(event: Event) {
    this.frameState = "ready";
    this.openRendererChannel(event.currentTarget as HTMLIFrameElement);
  }

  private frameUnavailable() {
    this.frameState = "unavailable";
    this.closeRendererChannel();
  }

  private syncGateway() {
    if (!this.context) return;
    const snapshot = this.context.gateway.snapshot;
    const nextClient = snapshot.client;
    const advertised = isGatewayMethodAdvertised(snapshot, "companion.attach") === true;
    if (!this.routeData?.localStageEnabled || !snapshot.connected || !nextClient || !advertised) {
      if (this.client || this.embodiment) this.releaseRuntime(true, true);
      this.runtimeState = this.routeData?.localStageEnabled
        ? advertised
          ? "disabled"
          : "unsupported"
        : "disabled";
      return;
    }
    if (nextClient === this.client && (this.runtimeState === "attaching" || this.embodiment)) {
      return;
    }
    if (this.client || this.embodiment) this.releaseRuntime(true, true);
    this.client = nextClient;
    this.runtimeState = "attaching";
    if (!this.channelPort && this.frameState === "ready") {
      const frame = this.querySelector<HTMLIFrameElement>(".companion-host__frame");
      if (frame) {
        this.frameState = "loading";
        frame.src = this.routeData.selection.url;
      }
    }
    const generation = ++this.attachGeneration;
    void nextClient
      .request("companion.attach", {})
      .then((payload) => {
        if (generation !== this.attachGeneration || this.client !== nextClient) return;
        const result = readCompanionAttachResult(payload);
        if (!result) throw new Error("invalid_companion_attach_response");
        this.attachedConversationId = result.conversationId;
        this.embodiment = createCompanionEmbodiment(result.conversationId);
        this.runtimeState = "attached";
        this.publishCommand(this.embodiment.bootstrap());
      })
      .catch(() => {
        if (generation === this.attachGeneration && this.client === nextClient) {
          this.embodiment = null;
          this.runtimeState = "failed";
        }
      });
  }

  private handleGatewayEvent(frame: GatewayEventFrame) {
    if (frame.event !== "companion.event" || !this.embodiment) return;
    const event = readCompanionEvent(frame.payload);
    if (!event) return;
    if (event.type === "semantic-command") {
      if (
        event.conversationId !== this.attachedConversationId ||
        event.sequence <= this.lastSemanticSequence
      ) {
        return;
      }
      this.lastSemanticSequence = event.sequence;
      const command: CompanionSemanticRendererCommand = {
        type: "set-companion-semantic",
        command: event.command,
        revision: event.sequence,
      };
      this.currentSemanticCommand = command;
      this.channelPort?.postMessage(command);
      return;
    }
    const command = this.embodiment.reduce({
      type: "bridge-event",
      event,
      observedAtMs: Date.now(),
    });
    if (command) this.publishCommand(command);
  }

  private publishCommand(command: CompanionRendererCommand) {
    this.currentCommand = command;
    this.channelPort?.postMessage(command);
    if (this.expiryTimer !== undefined) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (command.expiresAtMs !== undefined) {
      this.expiryTimer = window.setTimeout(
        () => {
          this.expiryTimer = undefined;
          const next = this.embodiment?.reduce({ type: "clock", observedAtMs: Date.now() });
          if (next) this.publishCommand(next);
        },
        Math.max(0, command.expiresAtMs - Date.now()),
      );
    }
  }

  private openRendererChannel(frame: HTMLIFrameElement) {
    this.closeRendererChannel();
    const selection = this.routeData?.selection;
    if (!frame.contentWindow || !selection) return;
    const channel = new MessageChannel();
    this.channelPort = channel.port1;
    this.channelPort.addEventListener("message", this.handleRendererMessage);
    this.channelPort.start();
    frame.contentWindow.postMessage(
      { type: COMPANION_CHANNEL_MESSAGE, protocol: COMPANION_CHANNEL_PROTOCOL },
      selection.origin,
      [channel.port2],
    );
    if (selection.renderer === "airi") {
      this.channelPort.postMessage({
        type: "set-companion-presentation",
        presentation: selection.presentation,
        revision: 1,
      });
    }
    if (this.currentCommand) this.channelPort.postMessage(this.currentCommand);
    if (this.currentSemanticCommand) this.channelPort.postMessage(this.currentSemanticCommand);
  }

  private readonly handleRendererMessage = (event: MessageEvent<unknown>) => {
    const intent = readCompanionRendererIntent(event.data);
    if (!intent || intent.sequence <= this.lastRendererIntentSequence) return;
    this.lastRendererIntentSequence = intent.sequence;
    if (intent.type === "open-main-chat") {
      this.context?.navigate("chat");
      return;
    }
    void this.cancel();
  };

  private closeRendererChannel() {
    this.channelPort?.removeEventListener("message", this.handleRendererMessage);
    this.channelPort?.close();
    this.channelPort = null;
    this.lastRendererIntentSequence = 0;
  }

  private releaseRuntime(detach: boolean, closeChannel: boolean) {
    const client = this.client;
    const wasAttached = this.embodiment !== null || this.runtimeState === "attaching";
    this.attachGeneration += 1;
    this.client = null;
    this.attachedConversationId = null;
    this.embodiment = null;
    this.currentCommand = null;
    this.currentSemanticCommand = null;
    this.lastSemanticSequence = 0;
    this.cancelling = false;
    if (this.expiryTimer !== undefined) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (closeChannel) this.closeRendererChannel();
    if (detach && client && wasAttached) {
      void client.request("companion.detach", {}).catch(() => undefined);
    }
  }

  private canCancel(): boolean {
    const snapshot = this.context?.gateway.snapshot;
    if (!snapshot) return false;
    return (
      this.runtimeState === "attached" &&
      isActiveState(this.currentCommand) &&
      isGatewayMethodAdvertised(snapshot, "companion.cancel") === true &&
      hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
    );
  }

  private async cancel() {
    const client = this.client;
    if (!client || !this.canCancel() || this.cancelling) return;
    this.cancelling = true;
    try {
      await client.request("companion.cancel", {});
    } finally {
      if (client === this.client) this.cancelling = false;
    }
  }

  private rendererStatusText(): string {
    if (this.frameState === "loading") return "Loading local Companion renderer…";
    if (this.frameState === "ready") return "Local Companion renderer ready";
    return "Local Companion renderer is unavailable";
  }

  private runtimeStatusText(): string {
    if (this.runtimeState === "unsupported") {
      return "Companion runtime is unavailable on this Gateway.";
    }
    if (this.runtimeState === "attaching") return "Connecting Companion to Main…";
    if (this.runtimeState === "attached") {
      return `Main · ${this.currentCommand?.state ?? "idle"}`;
    }
    if (this.runtimeState === "failed") return "Companion could not attach to Main.";
    return "Main Companion link is inactive.";
  }

  override render() {
    if (!this.routeData?.localStageEnabled) {
      return html`
        <section class="companion-host companion-host--unavailable" role="status">
          <p>Local Companion renderer is disabled.</p>
        </section>
      `;
    }

    return html`
      <section class="companion-host" data-frame-state=${this.frameState}>
        <div class="companion-host__stage">
          <iframe
            class="companion-host__frame"
            src=${this.routeData.selection.url}
            title=${this.routeData.selection.renderer === "airi"
              ? "AIRI Companion"
              : "Minimal Companion"}
            sandbox="allow-scripts allow-same-origin"
            allow="autoplay"
            referrerpolicy="no-referrer"
            @load=${this.frameLoaded}
            @error=${this.frameUnavailable}
          ></iframe>
        </div>
        <footer class="companion-host__dock" aria-label="Companion and Main status">
          <div class="companion-host__dock-copy">
            <p class="companion-host__dock-kicker">Companion / Main</p>
            <div class="companion-host__statuses" role="status">
              <span class="companion-host__status">${this.rendererStatusText()}</span>
              <span class="companion-host__runtime-status">${this.runtimeStatusText()}</span>
            </div>
          </div>
          <div class="companion-host__dock-actions">
            ${this.canCancel()
              ? html`<button
                  class="btn companion-host__cancel"
                  type="button"
                  ?disabled=${this.cancelling}
                  @click=${() => void this.cancel()}
                >
                  ${this.cancelling ? "Cancelling…" : "Cancel response"}
                </button>`
              : nothing}
            <button
              class="btn companion-host__chat"
              type="button"
              @click=${() => this.context?.navigate("chat")}
            >
              Open Main chat
            </button>
          </div>
        </footer>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-companion-page")) {
  customElements.define("openclaw-companion-page", CompanionPage);
}
