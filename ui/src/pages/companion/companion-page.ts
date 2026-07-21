import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { COMPANION_LOCAL_STAGE_URL } from "../../app/companion-stage.ts";
import type { CompanionRouteData } from "./route.ts";

type FrameState = "loading" | "ready" | "unavailable";

class CompanionPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) routeData?: CompanionRouteData;
  @state() private frameState: FrameState = "loading";

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.frameState = this.routeData?.localStageEnabled ? "loading" : "unavailable";
    }
  }

  private frameLoaded() {
    this.frameState = "ready";
  }

  private frameUnavailable() {
    this.frameState = "unavailable";
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
        <p class="companion-host__status" role="status">
          ${this.frameState === "loading"
            ? "Loading local Companion renderer…"
            : this.frameState === "ready"
              ? "Local Companion renderer ready"
              : "Local Companion renderer is unavailable"}
        </p>
        <iframe
          class="companion-host__frame"
          src=${COMPANION_LOCAL_STAGE_URL}
          title="AIRI Companion"
          sandbox="allow-scripts allow-same-origin"
          allow="autoplay"
          referrerpolicy="no-referrer"
          @load=${this.frameLoaded}
          @error=${this.frameUnavailable}
        ></iframe>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-companion-page")) {
  customElements.define("openclaw-companion-page", CompanionPage);
}
