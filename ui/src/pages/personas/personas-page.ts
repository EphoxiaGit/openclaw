import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type {
  AgentsFilesGetResult,
  PersonasGetResult,
  PersonasListResult,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";

type Persona = PersonasListResult["personas"][number];
const DEFAULT_REVISION = {
  identity: "A helpful assistant identity.",
  relationship: "A trusted collaborator for this conversation.",
  communicationStyle: "Clear, concise, and considerate.",
  behaviorGuidance: "Preserve user intent and backing Agent authority.",
  traits: { warmth: 0.7, directness: 0.7, playfulness: 0.2, formality: 0.4 },
};

@customElement("openclaw-personas-page")
export class PersonasPage extends LitElement {
  override createRenderRoot() {
    return this;
  }
  @consume({ context: applicationContext, subscribe: false }) private context!: ApplicationContext;
  @state() private selectedId: string | null = null;
  @state() private detail: PersonasGetResult | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private lucyPreview: { agentId: string; identity: string; soul: string } | null = null;
  @state() private lucyAgentId = "";
  private stop?: () => void;
  private stopAgents?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.stop = this.context.personas.subscribe(() => this.requestUpdate());
    this.stopAgents = this.context.agents.subscribe(() => this.requestUpdate());
    void this.context.personas.refresh(true);
    void this.context.agents.ensureList();
  }
  override disconnectedCallback() {
    this.stop?.();
    this.stopAgents?.();
    super.disconnectedCallback();
  }

  private get selected(): Persona | undefined {
    return this.context.personas.state.list?.personas.find(
      (persona) => persona.personaId === this.selectedId,
    );
  }

  private async select(personaId: string) {
    this.selectedId = personaId;
    this.detail = null;
    this.error = null;
    try {
      this.detail = await this.context.personas.get(personaId);
    } catch (error) {
      this.error = String(error);
    }
  }

  private async previewLucy() {
    const existing = this.context.personas.state.list?.personas.find(
      (persona) => persona.slug === "lucy",
    );
    if (existing) {
      if (existing.status === "archived") {
        await this.lifecycle("restore", existing, false);
      }
      await this.select(existing.personaId);
      return;
    }
    const agent = this.context.agents.state.agentsList?.agents.find(
      (candidate) => candidate.id === this.lucyAgentId,
    );
    const client = this.context.gateway.snapshot.client;
    if (!agent || !client) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const [identity, soul] = await Promise.all(
        ["IDENTITY.md", "SOUL.md"].map((name) =>
          client.request<AgentsFilesGetResult | null>("agents.files.get", {
            agentId: agent.id,
            name,
          }),
        ),
      );
      this.lucyPreview = {
        agentId: agent.id,
        identity: (identity?.file.content || DEFAULT_REVISION.identity).slice(0, 2_000),
        soul: (soul?.file.content || DEFAULT_REVISION.behaviorGuidance).slice(0, 4_000),
      };
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async createPersona(event: SubmitEvent) {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    const delegates = String(form.get("delegates") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    this.busy = true;
    this.error = null;
    try {
      const created = await this.context.personas.create({
        slug: String(form.get("slug")),
        displayName: String(form.get("displayName")),
        description: String(form.get("description")),
        primaryAgentId: String(form.get("primaryAgentId")),
        allowedDelegateAgentIds: delegates,
        revision: {
          identity: String(form.get("identity")),
          relationship: String(form.get("relationship")),
          communicationStyle: String(form.get("communicationStyle")),
          behaviorGuidance: String(form.get("behaviorGuidance")),
          traits: DEFAULT_REVISION.traits,
        },
        idempotencyKey: crypto.randomUUID(),
      });
      formElement.reset();
      await this.context.personas.refresh(true);
      await this.select(created.personaId);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async createLucy(event: SubmitEvent) {
    event.preventDefault();
    if (!this.lucyPreview) {
      return;
    }
    const form = new FormData(event.currentTarget as HTMLFormElement);
    this.busy = true;
    try {
      const created = await this.context.personas.create({
        slug: "lucy",
        displayName: String(form.get("displayName") || "Lucy"),
        description: String(form.get("description") || "Imported from Agent files."),
        primaryAgentId: this.lucyPreview.agentId,
        allowedDelegateAgentIds: [],
        revision: {
          ...DEFAULT_REVISION,
          identity: String(form.get("identity") || DEFAULT_REVISION.identity),
          behaviorGuidance: String(form.get("soul") || DEFAULT_REVISION.behaviorGuidance),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      this.lucyPreview = null;
      await this.context.personas.refresh(true);
      await this.select(created.personaId);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async updatePersona(event: SubmitEvent) {
    event.preventDefault();
    if (!this.detail) {
      return;
    }
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const delegates = String(form.get("delegates") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    this.busy = true;
    try {
      await this.context.personas.update({
        personaId: this.detail.persona.personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        metadata: {
          displayName: String(form.get("displayName")),
          description: String(form.get("description")),
        },
        primaryAgentId: String(form.get("primaryAgentId")),
        allowedDelegateAgentIds: delegates,
      });
      await this.context.personas.refresh(true);
      await this.select(this.detail.persona.personaId);
    } finally {
      this.busy = false;
    }
  }

  private async revise(event: SubmitEvent) {
    event.preventDefault();
    if (!this.detail) {
      return;
    }
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const current = this.detail.activeRevision.content;
    this.busy = true;
    try {
      await this.context.personas.revise({
        personaId: this.detail.persona.personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        reason: String(form.get("reason") || "Persona revision"),
        content: {
          identity: String(form.get("identity")),
          relationship: String(form.get("relationship")),
          communicationStyle: String(form.get("communicationStyle")),
          behaviorGuidance: String(form.get("behaviorGuidance")),
          traits: current.traits,
        },
      });
      await this.context.personas.refresh(true);
      await this.select(this.detail.persona.personaId);
    } finally {
      this.busy = false;
    }
  }

  private async rollback(sourceRevisionId: string) {
    if (!this.detail) {
      return;
    }
    this.busy = true;
    try {
      await this.context.personas.revise({
        personaId: this.detail.persona.personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        reason: `Rollback to ${sourceRevisionId}`,
        sourceRevisionId,
      });
      await this.context.personas.refresh(true);
      await this.select(this.detail.persona.personaId);
    } finally {
      this.busy = false;
    }
  }

  private async lifecycle(
    action: "archive" | "restore" | "delete",
    persona: Persona,
    requireConfirmation = true,
  ) {
    if (requireConfirmation && !confirm(`${action} ${persona.displayName}?`)) {
      return;
    }
    this.busy = true;
    try {
      await this.context.personas.lifecycle(action, {
        personaId: persona.personaId,
        expectedRevision: persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
      });
      if (action === "delete") {
        this.selectedId = null;
        this.detail = null;
      }
      await this.context.personas.refresh(true);
    } finally {
      this.busy = false;
    }
  }

  private renderDetail(detail: PersonasGetResult) {
    const { persona, activeRevision, revisions } = detail;
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    return html`<section class="card">
        <h2>${persona.displayName}</h2>
        ${persona.missingAgentIds.length
          ? html`<div class="callout warning">
              Missing Agents: ${persona.missingAgentIds.join(", ")}
            </div>`
          : nothing}
        <form class="stack" @submit=${this.updatePersona}>
          <label
            >Display name<input name="displayName" .value=${persona.displayName} required
          /></label>
          <label>Description<textarea name="description">${persona.description}</textarea></label>
          <label
            >Primary Agent<select name="primaryAgentId">
              ${agents.map(
                (agent) =>
                  html`<option value=${agent.id} ?selected=${agent.id === persona.primaryAgentId}>
                    ${agent.name ?? agent.id}
                  </option>`,
              )}
            </select></label
          >
          <label
            >Delegate Agent IDs<input
              name="delegates"
              .value=${persona.allowedDelegateAgentIds.join(", ")}
          /></label>
          <button class="btn primary" ?disabled=${this.busy}>Save metadata and bindings</button>
        </form>
      </section>
      <section class="card">
        <h2>Active revision ${activeRevision.revisionNumber}</h2>
        <form class="stack" @submit=${this.revise}>
          <label
            >Identity<textarea name="identity" required>
${activeRevision.content.identity}</textarea
            >
          </label>
          <label
            >Relationship<textarea name="relationship" required>
${activeRevision.content.relationship}</textarea
            >
          </label>
          <label
            >Communication style<textarea name="communicationStyle" required>
${activeRevision.content.communicationStyle}</textarea
            >
          </label>
          <label
            >Behavior guidance<textarea name="behaviorGuidance" required>
${activeRevision.content.behaviorGuidance}</textarea
            >
          </label>
          <label>Reason<input name="reason" value="Persona revision" required /></label>
          <button class="btn primary" ?disabled=${this.busy}>Create revision</button>
        </form>
        <h3>Revision history</h3>
        ${revisions.map(
          (revision) =>
            html`<div class="row">
              <span>#${revision.revisionNumber} · ${revision.reason}</span>${revision.revisionId ===
              persona.activeRevisionId
                ? html`<strong>Active</strong>`
                : html`<button
                    class="btn"
                    ?disabled=${this.busy}
                    @click=${() => void this.rollback(revision.revisionId)}
                  >
                    Rollback
                  </button>`}
            </div>`,
        )}
      </section>`;
  }

  override render() {
    const capability = this.context.personas.state;
    const personas = capability.list?.personas ?? [];
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    const selected = this.selected ?? personas[0];
    if (selected && selected.personaId !== this.selectedId) {
      void this.select(selected.personaId);
    }
    return html`<section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("personas")}</div>
          <div class="page-sub">${subtitleForRoute("personas")}</div>
        </div>
        <div class="row">
          <label
            >Lucy backing Agent<select
              .value=${this.lucyAgentId}
              @change=${(event: Event) => {
                this.lucyAgentId = (event.currentTarget as HTMLSelectElement).value;
              }}
            >
              <option value="">Select Agent</option>
              ${agents.map(
                (agent) => html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`,
              )}
            </select></label
          ><button
            class="btn"
            ?disabled=${this.busy || !this.lucyAgentId}
            @click=${() => void this.previewLucy()}
          >
            Import Lucy</button
          ><button
            class="btn"
            ?disabled=${capability.loading}
            @click=${() => void this.context.personas.refresh(true)}
          >
            Refresh
          </button>
        </div>
      </section>
      ${this.error || capability.error
        ? html`<div class="callout danger">${this.error ?? capability.error}</div>`
        : nothing}
      ${this.lucyPreview
        ? html`<section class="card">
            <h2>Preview Lucy import</h2>
            <p>
              Source Agent: ${this.lucyPreview.agentId}. Review this authorized IDENTITY.md and
              SOUL.md mapping before creation.
            </p>
            <form class="stack" @submit=${this.createLucy}>
              <label>Display name<input name="displayName" value="Lucy" required /></label
              ><label
                >Description<input
                  name="description"
                  value="Imported from Agent IDENTITY.md and SOUL.md." /></label
              ><label
                >Identity<textarea name="identity" required>
${this.lucyPreview.identity}</textarea
                ></label
              ><label
                >Behavior guidance (SOUL.md)<textarea name="soul" required>
${this.lucyPreview.soul}</textarea
                ></label
              ><button class="btn primary" ?disabled=${this.busy}>Create Lucy Persona</button>
            </form>
          </section>`
        : nothing}
      <section class="card">
        <h2>Create Persona</h2>
        <form class="stack" @submit=${this.createPersona}>
          <label
            >Slug<input name="slug" pattern="[a-z0-9][a-z0-9-]*" maxlength="64" required
          /></label>
          <label>Display name<input name="displayName" maxlength="120" required /></label>
          <label>Description<textarea name="description" maxlength="1000"></textarea></label>
          <label
            >Primary Agent<select name="primaryAgentId" required>
              <option value="">Select Agent</option>
              ${agents.map(
                (agent) => html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`,
              )}
            </select></label
          >
          <label>Delegate Agent IDs<input name="delegates" placeholder="agent-a, agent-b" /></label>
          <label
            >Identity<textarea name="identity" maxlength="2000" required>
${DEFAULT_REVISION.identity}</textarea
            >
          </label>
          <label
            >Relationship<textarea name="relationship" maxlength="2000" required>
${DEFAULT_REVISION.relationship}</textarea
            >
          </label>
          <label
            >Communication style<textarea name="communicationStyle" maxlength="2000" required>
${DEFAULT_REVISION.communicationStyle}</textarea
            >
          </label>
          <label
            >Behavior guidance<textarea name="behaviorGuidance" maxlength="4000" required>
${DEFAULT_REVISION.behaviorGuidance}</textarea
            >
          </label>
          <button class="btn primary" ?disabled=${this.busy}>Create Persona</button>
        </form>
      </section>
      <div class="settings-workspace">
        <aside class="settings-nav">
          ${personas.length === 0
            ? html`<p class="muted">No Personas yet.</p>`
            : personas.map(
                (persona) =>
                  html`<button
                    class="settings-nav__item ${selected?.personaId === persona.personaId
                      ? "active"
                      : ""}"
                    @click=${() => void this.select(persona.personaId)}
                  >
                    <strong>${persona.displayName}</strong
                    ><span>${persona.status} · ${persona.primaryAgentId}</span>
                  </button>`,
              )}
        </aside>
        <main class="settings-content">
          ${this.detail ? this.renderDetail(this.detail) : nothing}${selected
            ? html`<section class="card">
                <div class="row">
                  ${selected.status === "active"
                    ? html`<button
                        class="btn"
                        ?disabled=${this.busy}
                        @click=${() => void this.lifecycle("archive", selected)}
                      >
                        Archive
                      </button>`
                    : html`<button
                          class="btn"
                          ?disabled=${this.busy}
                          @click=${() => void this.lifecycle("restore", selected)}
                        >
                          Restore</button
                        ><button
                          class="btn danger"
                          ?disabled=${this.busy}
                          @click=${() => void this.lifecycle("delete", selected)}
                        >
                          Delete
                        </button>`}
                </div>
              </section>`
            : nothing}
        </main>
      </div>`;
  }
}
