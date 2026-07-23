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
type PersonasPanel =
  | "overview"
  | "identity"
  | "agents"
  | "memory"
  | "voice"
  | "embodiment"
  | "revisions";
type PersonasMode = "browse" | "create" | "import";
type TtsPersonaOption = { id: string; label?: string; description?: string; provider?: string };
type TtsPersonasResult = { personas: TtsPersonaOption[] };
type PersonaMemory = {
  recordId: string;
  personaId: string;
  key: string;
  content: string;
  confidence: number;
  sensitivity: "normal" | "sensitive";
  validFrom: number;
  validUntil?: number;
  expiresAt?: number;
  conflictStatus: "clear" | "conflicted";
  recordRevision: number;
  updatedAt: number;
};
type PersonaMemoryListResult = { memories: PersonaMemory[] };
type EmbodimentRefKey =
  | "characterRef"
  | "modelRef"
  | "sceneRef"
  | "expressionMapRef"
  | "manifestRef"
  | "animationPaletteRef";
const EMBODIMENT_FIELDS = [
  ["characterRef", "Character / card reference"],
  ["modelRef", "Model reference"],
  ["sceneRef", "Scene reference"],
  ["expressionMapRef", "Expression map reference"],
  ["manifestRef", "Manifest reference"],
  ["animationPaletteRef", "Animation palette reference"],
] as const satisfies ReadonlyArray<readonly [EmbodimentRefKey, string]>;
type TtsSpeakResult = {
  audioBase64: string;
  mimeType?: string;
  provider: string;
  providerModel?: string;
  providerVoice?: string;
};

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
  @state() private panel: PersonasPanel = "overview";
  @state() private mode: PersonasMode = "browse";
  @state() private busy = false;
  @state() private voiceBusy = false;
  @state() private error: string | null = null;
  @state() private lucyPreview: { agentId: string; identity: string; soul: string } | null = null;
  @state() private lucyAgentId = "";
  @state() private ttsPersonas: TtsPersonaOption[] = [];
  @state() private memories: PersonaMemory[] = [];
  @state() private memoryLoading = false;
  private selectionRequest = 0;
  private ttsPersonasRequest = 0;
  private voiceGeneration = 0;
  private voiceAudio: HTMLAudioElement | null = null;
  private voiceAudioUrl: string | null = null;
  private stop?: () => void;
  private stopAgents?: () => void;
  private stopGateway?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.stop = this.context.personas.subscribe(() => this.requestUpdate());
    this.stopAgents = this.context.agents.subscribe(() => this.requestUpdate());
    this.stopGateway = this.context.gateway.subscribe((snapshot) => {
      if (snapshot.connected) {
        void this.loadTtsPersonas(this.detail?.persona.primaryAgentId);
      }
    });
    void this.context.personas.refresh(true);
    void this.context.agents.ensureList();
    void this.loadTtsPersonas();
  }
  override disconnectedCallback() {
    this.stop?.();
    this.stopAgents?.();
    this.stopGateway?.();
    this.interruptVoice();
    super.disconnectedCallback();
  }

  private async loadTtsPersonas(agentId?: string) {
    const request = ++this.ttsPersonasRequest;
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    try {
      const result = await client.request<TtsPersonasResult>("tts.personas", {
        ...(agentId ? { agentId } : {}),
      });
      if (request === this.ttsPersonasRequest) {
        this.ttsPersonas = result.personas;
      }
    } catch {
      if (request === this.ttsPersonasRequest) {
        this.ttsPersonas = [];
      }
    }
  }

  // Each stop invalidates pending synthesis and revokes the prior object URL.
  // This keeps playback generation-owned and prevents browser-side voice retention.
  private interruptVoice() {
    this.voiceGeneration += 1;
    this.voiceAudio?.pause();
    this.voiceAudio = null;
    if (this.voiceAudioUrl) {
      URL.revokeObjectURL(this.voiceAudioUrl);
    }
    this.voiceAudioUrl = null;
    this.voiceBusy = false;
  }

  private get selected(): Persona | undefined {
    return this.context.personas.state.list?.personas.find(
      (persona) => persona.personaId === this.selectedId,
    );
  }

  private async select(personaId: string) {
    const request = ++this.selectionRequest;
    this.selectedId = personaId;
    this.mode = "browse";
    this.detail = null;
    this.error = null;
    try {
      const detail = await this.context.personas.get(personaId);
      if (request === this.selectionRequest && this.selectedId === personaId) {
        this.detail = detail;
        this.memories = [];
        void this.loadTtsPersonas(detail.persona.primaryAgentId);
      }
    } catch (error) {
      if (request === this.selectionRequest && this.selectedId === personaId) {
        this.error = String(error);
      }
    }
  }

  private async loadMemories() {
    const client = this.context.gateway.snapshot.client;
    const personaId = this.detail?.persona.personaId;
    if (!client || !personaId) return;
    this.memoryLoading = true;
    try {
      const result = await client.request<PersonaMemoryListResult>("personas.memory.list", {
        personaId,
        includeInvalid: true,
      });
      if (this.detail?.persona.personaId === personaId) this.memories = result.memories;
    } catch (error) {
      this.error = String(error);
    } finally {
      this.memoryLoading = false;
    }
  }

  private async createMemory(event: SubmitEvent) {
    event.preventDefault();
    const client = this.context.gateway.snapshot.client;
    const personaId = this.detail?.persona.personaId;
    if (!client || !personaId) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    this.busy = true;
    try {
      await client.request("personas.memory.create", {
        personaId,
        memory: {
          key: String(form.get("key") ?? ""),
          content: String(form.get("content") ?? ""),
          confidence: Number(form.get("confidence") ?? 0.8),
          sensitivity: String(form.get("sensitivity") ?? "normal"),
          conflictStatus: "clear",
          reason: "Created in Persona Memory",
          idempotencyKey: crypto.randomUUID(),
        },
      });
      (event.currentTarget as HTMLFormElement).reset();
      await this.loadMemories();
    } finally {
      this.busy = false;
    }
  }

  private async correctMemory(event: SubmitEvent, memory: PersonaMemory) {
    event.preventDefault();
    const client = this.context.gateway.snapshot.client;
    if (!client) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    this.busy = true;
    try {
      await client.request("personas.memory.correct", {
        personaId: memory.personaId,
        recordId: memory.recordId,
        expectedRevision: memory.recordRevision,
        memory: {
          key: memory.key,
          content: String(form.get("content") ?? memory.content),
          confidence: Number(form.get("confidence") ?? memory.confidence),
          sensitivity: String(form.get("sensitivity") ?? memory.sensitivity),
          conflictStatus: String(form.get("conflictStatus") ?? memory.conflictStatus),
          validFrom: memory.validFrom,
          ...(memory.validUntil === undefined ? {} : { validUntil: memory.validUntil }),
          ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
          reason: "Corrected in Persona Memory",
          idempotencyKey: crypto.randomUUID(),
        },
      });
      await this.loadMemories();
    } finally {
      this.busy = false;
    }
  }

  private async deleteMemory(memory: PersonaMemory) {
    const client = this.context.gateway.snapshot.client;
    if (!client || !confirm(`Delete memory “${memory.key}”?`)) return;
    await client.request("personas.memory.delete", {
      personaId: memory.personaId,
      recordId: memory.recordId,
      expectedRevision: memory.recordRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    await this.loadMemories();
  }

  private async exportMemory() {
    const client = this.context.gateway.snapshot.client;
    const personaId = this.detail?.persona.personaId;
    if (!client || !personaId) return;
    const result = await client.request<{ filename: string; json: string }>(
      "personas.memory.export",
      { personaId },
    );
    const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
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
    const delegates = form.has("delegates")
      ? String(form.get("delegates") || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : this.detail.persona.allowedDelegateAgentIds;
    this.busy = true;
    try {
      await this.context.personas.update({
        personaId: this.detail.persona.personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        metadata: {
          displayName: String(form.get("displayName") ?? this.detail.persona.displayName),
          description: String(form.get("description") ?? this.detail.persona.description),
        },
        primaryAgentId: String(form.get("primaryAgentId") ?? this.detail.persona.primaryAgentId),
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

  private async bindVoice(event: SubmitEvent) {
    event.preventDefault();
    if (!this.detail) {
      return;
    }
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const ttsPersonaId = String(form.get("ttsPersonaId") || "");
    this.busy = true;
    this.error = null;
    try {
      await this.context.personas.update({
        personaId: this.detail.persona.personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        ttsPersonaId: ttsPersonaId || null,
      });
      await this.context.personas.refresh(true);
      await this.select(this.detail.persona.personaId);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async bindEmbodiment(event: SubmitEvent) {
    event.preventDefault();
    if (!this.detail) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const embodimentBinding = Object.fromEntries(
      EMBODIMENT_FIELDS.map(([key]) => key)
        .map((key) => [key, String(form.get(key) || "").trim()] as const)
        .filter(([, value]) => value.length > 0),
    );
    this.busy = true;
    this.error = null;
    try {
      const personaId = this.detail.persona.personaId;
      await this.context.personas.update({
        personaId,
        expectedRevision: this.detail.persona.recordRevision,
        idempotencyKey: crypto.randomUUID(),
        embodimentBinding: Object.keys(embodimentBinding).length > 0 ? embodimentBinding : null,
      });
      await this.context.personas.refresh(true);
      await this.select(personaId);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.busy = false;
    }
  }

  private async previewVoice(event: SubmitEvent) {
    event.preventDefault();
    if (!this.detail?.persona.voiceBinding.ttsPersonaId) {
      return;
    }
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const text = String(new FormData(event.currentTarget as HTMLFormElement).get("preview") || "");
    this.interruptVoice();
    const generation = this.voiceGeneration;
    this.voiceBusy = true;
    this.error = null;
    try {
      const result = await client.request<TtsSpeakResult>("tts.speak", {
        text,
        persona: this.detail.persona.voiceBinding.ttsPersonaId,
        agentId: this.detail.persona.primaryAgentId,
      });
      if (generation !== this.voiceGeneration) {
        return;
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), (value) => value.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType ?? "audio/mpeg" }));
      const audio = new Audio(url);
      this.voiceAudio = audio;
      this.voiceAudioUrl = url;
      audio.addEventListener("ended", () => this.interruptVoice(), { once: true });
      await audio.play();
    } catch (error) {
      if (generation === this.voiceGeneration) {
        this.error = String(error);
      }
    } finally {
      if (generation === this.voiceGeneration) {
        this.voiceBusy = false;
      }
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
      if (action !== "delete") {
        await this.select(persona.personaId);
      }
    } finally {
      this.busy = false;
    }
  }

  private renderTabs(detail: PersonasGetResult) {
    const tabs: Array<{ id: PersonasPanel; label: string; count?: number }> = [
      { id: "overview", label: "Overview" },
      { id: "identity", label: "Identity & Personality" },
      {
        id: "agents",
        label: "Agent Binding",
        count: detail.persona.allowedDelegateAgentIds.length + 1,
      },
      { id: "voice", label: "Voice" },
      { id: "memory", label: "Memory", count: this.memories.length },
      { id: "embodiment", label: "Embodiment" },
      { id: "revisions", label: "Revisions", count: detail.revisions.length },
    ];
    return html`<div class="agent-tabs" role="tablist" aria-label="Persona settings">
      ${tabs.map(
        (tab) => html`<button
          class="agent-tab ${this.panel === tab.id ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${this.panel === tab.id ? "true" : "false"}
          @click=${() => {
            this.panel = tab.id;
            if (tab.id === "memory") void this.loadMemories();
          }}
        >
          ${tab.label}${tab.count == null
            ? nothing
            : html`<span class="agent-tab-count">${tab.count}</span>`}
        </button>`,
      )}
    </div>`;
  }

  private renderOverview(detail: PersonasGetResult) {
    const { persona, activeRevision } = detail;
    return html`<section class="card">
      <div class="personas-page__section-header">
        <div>
          <div class="card-title">Overview</div>
          <div class="card-sub">Identity metadata and lifecycle.</div>
        </div>
        <span class="pill">${persona.status}</span>
      </div>
      <div class="agents-overview-grid personas-page__summary">
        <div class="agent-kv">
          <div class="label">Slug</div>
          <div class="mono">${persona.slug}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Agent</div>
          <div class="mono">${persona.primaryAgentId}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Active revision</div>
          <div>#${activeRevision.revisionNumber}</div>
        </div>
      </div>
      <form class="stack personas-page__form" @submit=${this.updatePersona}>
        <div class="form-grid">
          <label class="field">
            <span>Display name</span>
            <input name="displayName" .value=${persona.displayName} maxlength="120" required />
          </label>
          <label class="field full">
            <span>Description</span>
            <textarea name="description" maxlength="1000">${persona.description}</textarea>
          </label>
        </div>
        <div class="personas-page__actions">
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Save profile
          </button>
        </div>
      </form>
      <div class="personas-page__lifecycle">
        <div>
          <div class="label">Lifecycle</div>
          <div class="card-sub">Archive unused Personas before permanently deleting them.</div>
        </div>
        <div class="personas-page__actions">
          ${persona.status === "active"
            ? html`<button
                type="button"
                class="btn btn--sm"
                ?disabled=${this.busy}
                @click=${() => void this.lifecycle("archive", persona)}
              >
                Archive
              </button>`
            : html`<button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => void this.lifecycle("restore", persona)}
                >
                  Restore</button
                ><button
                  type="button"
                  class="btn btn--sm danger"
                  ?disabled=${this.busy}
                  @click=${() => void this.lifecycle("delete", persona)}
                >
                  Delete
                </button>`}
        </div>
      </div>
    </section>`;
  }

  private renderIdentity(detail: PersonasGetResult) {
    const { activeRevision } = detail;
    return html`<section class="card">
      <div class="card-title">Identity & Personality</div>
      <div class="card-sub">
        Create an immutable revision of this Persona's identity and behavior.
      </div>
      <form class="stack personas-page__form" @submit=${this.revise}>
        <div class="form-grid personas-page__identity-grid">
          <label class="field">
            <span>Identity</span>
            <textarea name="identity" required>${activeRevision.content.identity}</textarea>
          </label>
          <label class="field">
            <span>Relationship</span>
            <textarea name="relationship" required>${activeRevision.content.relationship}</textarea>
          </label>
          <label class="field">
            <span>Communication style</span>
            <textarea name="communicationStyle" required>
${activeRevision.content.communicationStyle}</textarea
            >
          </label>
          <label class="field">
            <span>Behavior guidance</span>
            <textarea name="behaviorGuidance" required>
${activeRevision.content.behaviorGuidance}</textarea
            >
          </label>
          <label class="field full">
            <span>Revision reason</span>
            <input name="reason" value="Persona revision" required />
          </label>
        </div>
        <div class="personas-page__actions">
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Create revision
          </button>
        </div>
      </form>
    </section>`;
  }

  private renderAgentBinding(detail: PersonasGetResult) {
    const { persona } = detail;
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    return html`<section class="card">
      <div class="card-title">Agent Binding</div>
      <div class="card-sub">
        Choose the primary execution Agent and the Agents this Persona may delegate to.
      </div>
      <div class="agent-kv personas-page__form">
        <div class="label">Effective voice</div>
        <div>
          ${persona.voiceBinding.status === "unbound"
            ? "Not bound"
            : `${persona.voiceBinding.ttsPersonaId} · ${persona.voiceBinding.status}`}
        </div>
      </div>
      ${persona.missingAgentIds.length
        ? html`<div class="callout warn personas-page__form">
            Missing Agents: ${persona.missingAgentIds.join(", ")}
          </div>`
        : nothing}
      <form class="stack personas-page__form" @submit=${this.updatePersona}>
        <div class="form-grid">
          <label class="field">
            <span>Primary Agent</span>
            <select name="primaryAgentId" required>
              ${agents.map(
                (agent) => html`<option
                  value=${agent.id}
                  ?selected=${agent.id === persona.primaryAgentId}
                >
                  ${agent.name ?? agent.id}
                </option>`,
              )}
            </select>
          </label>
          <label class="field">
            <span>Delegate Agent IDs</span>
            <input
              name="delegates"
              .value=${persona.allowedDelegateAgentIds.join(", ")}
              placeholder="agent-a, agent-b"
            />
          </label>
        </div>
        <div class="personas-page__actions">
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Save Agent binding
          </button>
        </div>
      </form>
    </section>`;
  }

  private renderVoice(detail: PersonasGetResult) {
    const binding = detail.persona.voiceBinding;
    return html`<section class="card">
      <div class="card-title">Voice</div>
      <div class="card-sub">Bind this Persona to an existing server-owned named TTS persona.</div>
      ${binding.status === "missing"
        ? html`<div class="callout warn personas-page__form">
            Named TTS persona “${binding.ttsPersonaId}” is no longer configured.
          </div>`
        : binding.status === "unavailable"
          ? html`<div class="callout warn personas-page__form">
              ${binding.ttsPersonaId} cannot currently synthesize with
              ${binding.provider ?? "the configured provider"}.
            </div>`
          : nothing}
      <form class="stack personas-page__form" @submit=${this.bindVoice}>
        <label class="field personas-page__bounded-field">
          <span>Named TTS persona</span>
          <select name="ttsPersonaId">
            <option value="" ?selected=${binding.status === "unbound"}>No voice binding</option>
            ${binding.ttsPersonaId &&
            !this.ttsPersonas.some((persona) => persona.id === binding.ttsPersonaId)
              ? html`<option value=${binding.ttsPersonaId} selected>
                  ${binding.ttsPersonaId}${binding.status === "missing"
                    ? " (missing)"
                    : " (current binding)"}
                </option>`
              : nothing}
            ${this.ttsPersonas.map(
              (persona) => html`<option
                value=${persona.id}
                ?selected=${persona.id === binding.ttsPersonaId}
              >
                ${persona.label ?? persona.id}${persona.provider ? ` · ${persona.provider}` : ""}
              </option>`,
            )}
          </select>
        </label>
        ${this.ttsPersonas.length === 0
          ? html`<div class="stack">
              <div class="muted">
                Named voice profiles are configured in Settings under Communications → Messages.
                Configure one there, then return here to bind it to this Persona.
              </div>
              <div class="personas-page__actions personas-page__actions--start">
                <button
                  type="button"
                  class="btn btn--sm"
                  @click=${() =>
                    this.context.navigate("communications", {
                      search: "?section=messages&subsection=tts",
                    })}
                >
                  Configure voice settings
                </button>
              </div>
            </div>`
          : nothing}
        <div class="personas-page__actions personas-page__actions--start">
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Save voice binding
          </button>
        </div>
      </form>
      <div class="agents-overview-grid personas-page__summary">
        <div class="agent-kv">
          <div class="label">Status</div>
          <div>${binding.status}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Provider</div>
          <div>${binding.provider ?? "Not resolved"}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Model / voice</div>
          <div>
            ${[binding.model, binding.voice].filter(Boolean).join(" · ") || "Provider default"}
          </div>
        </div>
      </div>
      <form class="stack personas-page__form" @submit=${this.previewVoice}>
        <label class="field full">
          <span>Preview phrase</span>
          <input name="preview" value="Hello. This is my configured voice." required />
        </label>
        <div class="personas-page__actions personas-page__actions--start">
          <button
            type="submit"
            class="btn btn--sm"
            ?disabled=${this.voiceBusy || binding.status !== "ready"}
          >
            Play preview
          </button>
          <button type="button" class="btn btn--sm" @click=${this.interruptVoice}>Stop</button>
        </div>
      </form>
    </section>`;
  }

  private renderEmbodiment(detail: PersonasGetResult) {
    const binding = detail.persona.embodimentBinding;
    const value = (key: EmbodimentRefKey) =>
      binding.status === "bound" ? (binding[key] ?? "") : "";
    return html`<section class="card">
      <div class="card-title">Embodiment</div>
      <div class="card-sub">
        AIRI renders these references as presentation only. OpenClaw retains Agent authority and
        stores only opaque identifiers, never asset locations.
      </div>
      <div class="agent-kv personas-page__form">
        <div class="label">Status</div>
        <div>${binding.status}</div>
      </div>
      <form class="stack personas-page__form" @submit=${this.bindEmbodiment}>
        <div class="form-grid">
          ${EMBODIMENT_FIELDS.map(
            ([key, label]) => html`<label class="field">
              <span>${label}</span>
              <input
                name=${key}
                .value=${value(key)}
                maxlength="128"
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              />
            </label>`,
          )}
        </div>
        <div class="personas-page__actions personas-page__actions--start">
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Save embodiment
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${this.busy || binding.status === "unbound"}
            @click=${() => {
              const form = this.renderRoot.querySelector<HTMLFormElement>(
                'form input[name="characterRef"]',
              )?.form;
              form
                ?.querySelectorAll<HTMLInputElement>("input")
                .forEach((input) => (input.value = ""));
              form?.requestSubmit();
            }}
          >
            Clear
          </button>
        </div>
      </form>
    </section>`;
  }

  private renderRevisions(detail: PersonasGetResult) {
    return html`<section class="card">
      <div class="card-title">Revision history</div>
      <div class="card-sub">Review or restore a previous immutable Persona revision.</div>
      <div class="personas-page__history">
        ${detail.revisions.length === 0
          ? html`<div class="muted">No revisions recorded.</div>`
          : detail.revisions.map(
              (revision) => html`<div class="personas-page__revision-row">
                <div>
                  <strong>#${revision.revisionNumber}</strong>
                  <span class="muted"> · ${revision.reason}</span>
                </div>
                ${revision.revisionId === detail.persona.activeRevisionId
                  ? html`<span class="pill">Active</span>`
                  : html`<button
                      type="button"
                      class="btn btn--sm"
                      ?disabled=${this.busy}
                      @click=${() => void this.rollback(revision.revisionId)}
                    >
                      Rollback
                    </button>`}
              </div>`,
            )}
      </div>
    </section>`;
  }

  private renderMemory() {
    return html`<section class="card">
      <div class="personas-page__section-header">
        <div>
          <div class="card-title">Persona Memory</div>
          <div class="card-sub">
            Durable memory follows this Persona when its primary Agent changes.
          </div>
        </div>
        <button type="button" class="btn btn--sm" @click=${() => void this.exportMemory()}>
          Export JSON
        </button>
      </div>
      <form class="stack personas-page__form" @submit=${this.createMemory}>
        <div class="form-grid personas-page__identity-grid">
          <label class="field"><span>Key</span><input name="key" maxlength="160" required /></label>
          <label class="field"
            ><span>Confidence</span
            ><input
              name="confidence"
              type="number"
              min="0"
              max="1"
              step="0.05"
              value="0.8"
              required
          /></label>
          <label class="field"
            ><span>Sensitivity</span
            ><select name="sensitivity">
              <option value="normal">Normal</option>
              <option value="sensitive">Sensitive</option>
            </select></label
          >
        </div>
        <label class="field"
          ><span>Memory</span><textarea name="content" maxlength="8000" required></textarea>
        </label>
        <div class="personas-page__actions">
          <button class="btn btn--sm primary" type="submit" ?disabled=${this.busy}>Remember</button>
        </div>
      </form>
      <div class="personas-page__history">
        ${this.memoryLoading
          ? html`<div class="muted">Loading memory…</div>`
          : this.memories.length === 0
            ? html`<div class="muted">No Persona memories recorded.</div>`
            : this.memories.map(
                (memory) => html`<form
                  class="personas-page__revision-row stack"
                  @submit=${(event: SubmitEvent) => this.correctMemory(event, memory)}
                >
                  <div>
                    <strong>${memory.key}</strong>
                    <span class="pill">r${memory.recordRevision}</span>
                  </div>
                  <label class="field"
                    ><span>Memory</span
                    ><textarea name="content" maxlength="8000" .value=${memory.content}></textarea>
                  </label>
                  <div class="form-grid personas-page__identity-grid">
                    <label class="field"
                      ><span>Confidence</span
                      ><input
                        name="confidence"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        .value=${String(memory.confidence)}
                    /></label>
                    <label class="field"
                      ><span>Sensitivity</span
                      ><select name="sensitivity">
                        <option value="normal" ?selected=${memory.sensitivity === "normal"}>
                          Normal
                        </option>
                        <option value="sensitive" ?selected=${memory.sensitivity === "sensitive"}>
                          Sensitive
                        </option>
                      </select></label
                    >
                    <label class="field"
                      ><span>Conflict</span
                      ><select name="conflictStatus">
                        <option value="clear" ?selected=${memory.conflictStatus === "clear"}>
                          Clear
                        </option>
                        <option
                          value="conflicted"
                          ?selected=${memory.conflictStatus === "conflicted"}
                        >
                          Conflicted
                        </option>
                      </select></label
                    >
                  </div>
                  <div class="muted">
                    Valid from
                    ${new Date(memory.validFrom).toLocaleString()}${memory.validUntil
                      ? ` until ${new Date(memory.validUntil).toLocaleString()}`
                      : ""}${memory.expiresAt
                      ? ` · expires ${new Date(memory.expiresAt).toLocaleString()}`
                      : ""}
                  </div>
                  <div class="personas-page__actions">
                    <button class="btn btn--sm primary" type="submit" ?disabled=${this.busy}>
                      Correct</button
                    ><button
                      class="btn btn--sm danger"
                      type="button"
                      @click=${() => void this.deleteMemory(memory)}
                    >
                      Delete
                    </button>
                  </div>
                </form>`,
              )}
      </div>
    </section>`;
  }

  private renderSelected(detail: PersonasGetResult) {
    return html`${this.renderTabs(detail)}${this.panel === "overview"
      ? this.renderOverview(detail)
      : this.panel === "identity"
        ? this.renderIdentity(detail)
        : this.panel === "agents"
          ? this.renderAgentBinding(detail)
          : this.panel === "memory"
            ? this.renderMemory()
            : this.panel === "voice"
              ? this.renderVoice(detail)
              : this.panel === "embodiment"
                ? this.renderEmbodiment(detail)
                : this.renderRevisions(detail)}`;
  }

  private renderCreate() {
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    return html`<section class="card">
      <div class="card-title">Create Persona</div>
      <div class="card-sub">Add a reusable identity above Agents without changing Agent files.</div>
      <form class="stack personas-page__form" @submit=${this.createPersona}>
        <div class="form-grid personas-page__identity-grid">
          <label class="field">
            <span>Slug</span>
            <input name="slug" pattern="[a-z0-9][a-z0-9-]*" maxlength="64" required />
          </label>
          <label class="field">
            <span>Display name</span>
            <input name="displayName" maxlength="120" required />
          </label>
          <label class="field">
            <span>Primary Agent</span>
            <select name="primaryAgentId" required>
              <option value="">Select Agent</option>
              ${agents.map(
                (agent) => html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`,
              )}
            </select>
          </label>
          <label class="field">
            <span>Delegate Agent IDs</span>
            <input name="delegates" placeholder="agent-a, agent-b" />
          </label>
          <label class="field full">
            <span>Description</span>
            <textarea name="description" maxlength="1000"></textarea>
          </label>
        </div>
        <div class="personas-page__form-section">
          <div class="label">Identity & behavior</div>
          <div class="form-grid personas-page__identity-grid">
            <label class="field">
              <span>Identity</span>
              <textarea name="identity" maxlength="2000" required>
${DEFAULT_REVISION.identity}</textarea
              >
            </label>
            <label class="field">
              <span>Relationship</span>
              <textarea name="relationship" maxlength="2000" required>
${DEFAULT_REVISION.relationship}</textarea
              >
            </label>
            <label class="field">
              <span>Communication style</span>
              <textarea name="communicationStyle" maxlength="2000" required>
${DEFAULT_REVISION.communicationStyle}</textarea
              >
            </label>
            <label class="field">
              <span>Behavior guidance</span>
              <textarea name="behaviorGuidance" maxlength="4000" required>
${DEFAULT_REVISION.behaviorGuidance}</textarea
              >
            </label>
          </div>
        </div>
        <div class="personas-page__actions">
          <button type="button" class="btn btn--sm" @click=${() => (this.mode = "browse")}>
            Cancel
          </button>
          <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
            Create Persona
          </button>
        </div>
      </form>
    </section>`;
  }

  private renderImport() {
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    return html`<section class="card">
      <div class="card-title">Import Lucy</div>
      <div class="card-sub">Create Lucy from an Agent's IDENTITY.md and SOUL.md files.</div>
      <div class="stack personas-page__form">
        <label class="field personas-page__bounded-field">
          <span>Backing Agent</span>
          <select
            .value=${this.lucyAgentId}
            @change=${(event: Event) => {
              this.lucyAgentId = (event.currentTarget as HTMLSelectElement).value;
            }}
          >
            <option value="">Select Agent</option>
            ${agents.map(
              (agent) => html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`,
            )}
          </select>
        </label>
        <div class="personas-page__actions personas-page__actions--start">
          <button type="button" class="btn btn--sm" @click=${() => (this.mode = "browse")}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${this.busy || !this.lucyAgentId}
            @click=${() => void this.previewLucy()}
          >
            Preview import
          </button>
        </div>
        ${this.lucyPreview
          ? html`<form class="stack personas-page__form-section" @submit=${this.createLucy}>
              <div class="card-sub">Source Agent: ${this.lucyPreview.agentId}</div>
              <div class="form-grid personas-page__identity-grid">
                <label class="field">
                  <span>Display name</span>
                  <input name="displayName" value="Lucy" required />
                </label>
                <label class="field">
                  <span>Description</span>
                  <input name="description" value="Imported from Agent IDENTITY.md and SOUL.md." />
                </label>
                <label class="field">
                  <span>Identity</span>
                  <textarea name="identity" required>${this.lucyPreview.identity}</textarea>
                </label>
                <label class="field">
                  <span>Behavior guidance (SOUL.md)</span>
                  <textarea name="soul" required>${this.lucyPreview.soul}</textarea>
                </label>
              </div>
              <div class="personas-page__actions">
                <button type="submit" class="btn btn--sm primary" ?disabled=${this.busy}>
                  Create Lucy Persona
                </button>
              </div>
            </form>`
          : nothing}
      </div>
    </section>`;
  }

  override render() {
    const capability = this.context.personas.state;
    const personas = capability.list?.personas ?? [];
    const selected = this.selected ?? personas[0];
    if (selected && selected.personaId !== this.selectedId) {
      void this.select(selected.personaId);
    }
    const detail = this.detail?.persona.personaId === selected?.personaId ? this.detail : null;
    return html`<section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("personas")}</div>
          <div class="page-sub">${subtitleForRoute("personas")}</div>
        </div>
      </section>
      <div class="agents-layout personas-page">
        <section class="agents-toolbar">
          <div class="agents-toolbar-row">
            <div class="agents-control-select">
              <select
                class="agents-select"
                .value=${selected?.personaId ?? ""}
                ?disabled=${capability.loading || personas.length === 0}
                @change=${(event: Event) => {
                  const personaId = (event.currentTarget as HTMLSelectElement).value;
                  if (personaId) {
                    void this.select(personaId);
                  }
                }}
              >
                ${personas.length === 0
                  ? html`<option value="">No Personas yet</option>`
                  : personas.map(
                      (persona) => html`<option
                        value=${persona.personaId}
                        ?selected=${persona.personaId === selected?.personaId}
                      >
                        ${persona.displayName}${persona.status === "archived" ? " (archived)" : ""}
                      </option>`,
                    )}
              </select>
            </div>
            <div class="agents-toolbar-actions">
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                @click=${() => {
                  this.mode = "create";
                  this.error = null;
                }}
              >
                New Persona
              </button>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                @click=${() => {
                  this.mode = "import";
                  this.error = null;
                  this.lucyPreview = null;
                }}
              >
                Import Lucy
              </button>
              <button
                type="button"
                class="btn btn--sm agents-refresh-btn"
                ?disabled=${capability.loading}
                @click=${() => void this.context.personas.refresh(true)}
              >
                ${capability.loading ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>
        </section>
        <section class="agents-main">
          ${this.error || capability.error
            ? html`<div class="callout danger">${this.error ?? capability.error}</div>`
            : nothing}
          ${this.mode === "create"
            ? this.renderCreate()
            : this.mode === "import"
              ? this.renderImport()
              : detail
                ? this.renderSelected(detail)
                : selected
                  ? html`<section class="card personas-page__empty muted" role="status">
                      Loading ${selected.displayName}…
                    </section>`
                  : html`<section class="card">
                      <div class="card-title">Create your first Persona</div>
                      <div class="card-sub">
                        Personas combine identity and personality with one or more Agents.
                      </div>
                      <div class="personas-page__actions personas-page__actions--start">
                        <button
                          type="button"
                          class="btn btn--sm primary"
                          @click=${() => (this.mode = "create")}
                        >
                          New Persona
                        </button>
                      </div>
                    </section>`}
        </section>
      </div>`;
  }
}
