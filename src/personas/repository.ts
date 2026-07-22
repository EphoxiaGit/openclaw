import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  PersonaConflictError,
  PersonaNotFoundError,
  PersonaValidationError,
  type Persona,
  type PersonaRevision,
  type PersonaRevisionContent,
  type PersonaSelection,
  type PersonaStatus,
  type PersonaTransition,
  type PersonaTransitionAction,
} from "./types.js";

type Options = OpenClawStateDatabaseOptions & { now?: () => number };
type Row = Record<string, string | number | null>;
type PersonaVoiceDatabase = Pick<OpenClawStateKyselyDatabase, "persona_voice_bindings">;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_DELEGATES = 16;

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new PersonaValidationError(`${label} must be 1-${max} characters`);
  }
  return value.trim();
}

function validateContent(value: PersonaRevisionContent): PersonaRevisionContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaValidationError("revision content must be an object");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "behaviorGuidance,communicationStyle,identity,relationship,traits") {
    throw new PersonaValidationError("revision content contains unknown fields");
  }
  const traitKeys = Object.keys(value.traits ?? {}).toSorted();
  if (traitKeys.join(",") !== "directness,formality,playfulness,warmth") {
    throw new PersonaValidationError("traits contain unknown fields");
  }
  for (const [name, trait] of Object.entries(value.traits)) {
    if (!Number.isFinite(trait) || trait < 0 || trait > 1) {
      throw new PersonaValidationError(`${name} must be between 0 and 1`);
    }
  }
  return {
    identity: text(value.identity, "identity", 2_000),
    relationship: text(value.relationship, "relationship", 2_000),
    communicationStyle: text(value.communicationStyle, "communicationStyle", 2_000),
    behaviorGuidance: text(value.behaviorGuidance, "behaviorGuidance", 4_000),
    traits: { ...value.traits },
  };
}

function validateAgents(
  primary: string,
  delegates: readonly string[],
  configured: ReadonlySet<string>,
) {
  if (!ID.test(primary) || !configured.has(primary)) {
    throw new PersonaValidationError(`Agent is not configured: ${primary}`);
  }
  if (delegates.length > MAX_DELEGATES || new Set(delegates).size !== delegates.length) {
    throw new PersonaValidationError("delegate Agent list is invalid");
  }
  for (const delegate of delegates) {
    if (!ID.test(delegate) || delegate === primary || !configured.has(delegate)) {
      throw new PersonaValidationError(`Invalid delegate Agent: ${delegate}`);
    }
  }
}

export class PersonaRepository {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #options: OpenClawStateDatabaseOptions;

  constructor(options: Options = {}) {
    this.#options = { env: options.env, path: options.path };
    this.#db = openOpenClawStateDatabase(options).db;
    this.#now = options.now ?? Date.now;
  }

  list(configuredAgentIds: ReadonlySet<string>, includeArchived = false): Persona[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM personas ${includeArchived ? "" : "WHERE status='active'"} ORDER BY display_name, persona_id`,
      )
      .all() as Row[];
    return rows.map((row) => this.#persona(row, configuredAgentIds));
  }

  get(personaId: string, configuredAgentIds: ReadonlySet<string>): Persona {
    return this.#persona(this.#require(personaId), configuredAgentIds);
  }

  getRevision(revisionId: string): PersonaRevision {
    const row = this.#db
      .prepare("SELECT * FROM persona_revisions WHERE revision_id=?")
      .get(revisionId) as Row | undefined;
    if (!row) throw new PersonaNotFoundError(`Persona revision not found: ${revisionId}`);
    return this.#revision(row);
  }

  listRevisions(personaId: string): PersonaRevision[] {
    this.#require(personaId);
    return (
      this.#db
        .prepare("SELECT * FROM persona_revisions WHERE persona_id=? ORDER BY revision_number DESC")
        .all(personaId) as Row[]
    ).map((row) => this.#revision(row));
  }

  create(input: {
    slug: string;
    displayName: string;
    description: string;
    primaryAgentId: string;
    allowedDelegateAgentIds: string[];
    ttsPersonaId?: string;
    revision: PersonaRevisionContent;
    actorId: string;
    authorId: string;
    reason: string;
    provenance?: string;
    idempotencyKey: string;
    configuredAgentIds: ReadonlySet<string>;
  }): Persona {
    const slug = text(input.slug, "slug", 64);
    if (!SLUG.test(slug)) throw new PersonaValidationError("invalid Persona slug");
    validateAgents(input.primaryAgentId, input.allowedDelegateAgentIds, input.configuredAgentIds);
    const content = validateContent(input.revision);
    const requestHash = hash({ ...input, configuredAgentIds: undefined });
    return runOpenClawStateWriteTransaction(() => {
      const replay = this.#replay<Persona>(`create:${slug}`, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const duplicate = this.#db.prepare("SELECT persona_id FROM personas WHERE slug=?").get(slug);
      if (duplicate) {
        throw new PersonaConflictError(`Persona slug is already in use: ${slug}`);
      }
      const now = this.#now();
      const personaId = randomUUID();
      const revisionId = randomUUID();
      this.#db
        .prepare("INSERT INTO personas VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          personaId,
          slug,
          text(input.displayName, "displayName", 120),
          typeof input.description === "string" ? input.description.trim().slice(0, 1_000) : "",
          "active",
          input.primaryAgentId,
          revisionId,
          1,
          now,
          now,
        );
      this.#db
        .prepare("INSERT INTO persona_revisions VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          revisionId,
          personaId,
          1,
          null,
          JSON.stringify(content),
          text(input.authorId, "authorId", 120),
          text(input.reason, "reason", 500),
          input.provenance?.slice(0, 500) ?? null,
          now,
        );
      this.#replaceDelegates(personaId, input.allowedDelegateAgentIds);
      this.#replaceVoiceBinding(personaId, input.ttsPersonaId);
      const result = this.get(personaId, input.configuredAgentIds);
      this.#transition(personaId, "create", input.actorId, requestHash, { recordRevision: 1 }, now);
      this.#receipt(`create:${slug}`, input.idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  update(input: {
    personaId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    configuredAgentIds: ReadonlySet<string>;
    displayName?: string;
    description?: string;
    primaryAgentId?: string;
    allowedDelegateAgentIds?: string[];
    ttsPersonaId?: string | null;
  }): Persona {
    const requestHash = hash({ ...input, configuredAgentIds: undefined });
    return this.#mutate(
      input.personaId,
      input.expectedRevision,
      input.idempotencyKey,
      requestHash,
      "update",
      input.actorId,
      input.configuredAgentIds,
      (row, now) => {
        const primary = input.primaryAgentId ?? String(row.primary_agent_id);
        const delegates = input.allowedDelegateAgentIds ?? this.#delegates(input.personaId);
        validateAgents(primary, delegates, input.configuredAgentIds);
        this.#db
          .prepare(
            "UPDATE personas SET display_name=?,description=?,primary_agent_id=?,record_revision=record_revision+1,updated_at=? WHERE persona_id=?",
          )
          .run(
            input.displayName === undefined
              ? row.display_name
              : text(input.displayName, "displayName", 120),
            input.description === undefined
              ? row.description
              : input.description.trim().slice(0, 1_000),
            primary,
            now,
            input.personaId,
          );
        this.#replaceDelegates(input.personaId, delegates);
        if (input.ttsPersonaId !== undefined) {
          this.#replaceVoiceBinding(input.personaId, input.ttsPersonaId ?? undefined);
        }
      },
    );
  }

  revise(input: {
    personaId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    authorId: string;
    reason: string;
    provenance?: string;
    content?: PersonaRevisionContent;
    sourceRevisionId?: string;
    configuredAgentIds: ReadonlySet<string>;
  }): { persona: Persona; revision: PersonaRevision } {
    const source = input.sourceRevisionId ? this.getRevision(input.sourceRevisionId) : undefined;
    if (source && source.personaId !== input.personaId)
      throw new PersonaValidationError("source revision belongs to another Persona");
    const content = validateContent(input.content ?? (source?.content as PersonaRevisionContent));
    const requestHash = hash({ ...input, configuredAgentIds: undefined, content });
    return runOpenClawStateWriteTransaction(() => {
      const replay = this.#replay<{ persona: Persona; revision: PersonaRevision }>(
        input.personaId,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const row = this.#requireRevision(input.personaId, input.expectedRevision);
      this.#assertReferences(row, input.configuredAgentIds);
      const latest = Number(
        (
          this.#db
            .prepare("SELECT MAX(revision_number) AS n FROM persona_revisions WHERE persona_id=?")
            .get(input.personaId) as Row
        ).n ?? 0,
      );
      const revisionId = randomUUID();
      const now = this.#now();
      this.#db
        .prepare("INSERT INTO persona_revisions VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          revisionId,
          input.personaId,
          latest + 1,
          row.active_revision_id,
          JSON.stringify(content),
          text(input.authorId, "authorId", 120),
          text(input.reason, "reason", 500),
          input.provenance?.slice(0, 500) ?? null,
          now,
        );
      this.#db
        .prepare(
          "UPDATE personas SET active_revision_id=?,record_revision=record_revision+1,updated_at=? WHERE persona_id=?",
        )
        .run(revisionId, now, input.personaId);
      const result = {
        persona: this.get(input.personaId, input.configuredAgentIds),
        revision: this.getRevision(revisionId),
      };
      this.#transition(
        input.personaId,
        "revise",
        input.actorId,
        requestHash,
        { revisionId, revisionNumber: latest + 1 },
        now,
      );
      this.#receipt(input.personaId, input.idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  setStatus(input: {
    personaId: string;
    status: PersonaStatus;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    configuredAgentIds: ReadonlySet<string>;
  }): { persona: Persona; clearedSessionKeys: string[] } {
    const action = input.status === "archived" ? "archive" : "restore";
    const requestHash = hash(input);
    return runOpenClawStateWriteTransaction(() => {
      const replay = this.#replay<{ persona: Persona; clearedSessionKeys: string[] }>(
        input.personaId,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const row = this.#requireRevision(input.personaId, input.expectedRevision);
      if (row.status === input.status) {
        throw new PersonaConflictError(`Persona is already ${input.status}`);
      }
      const now = this.#now();
      const clearedSessionKeys =
        input.status === "archived"
          ? (
              this.#db
                .prepare(
                  "SELECT session_key FROM persona_session_selections WHERE persona_id=? ORDER BY session_key",
                )
                .all(input.personaId) as Row[]
            ).map((selection) => text(selection.session_key, "sessionKey", 512))
          : [];
      this.#db
        .prepare(
          "UPDATE personas SET status=?,record_revision=record_revision+1,updated_at=? WHERE persona_id=?",
        )
        .run(input.status, now, input.personaId);
      if (input.status === "archived") {
        this.#db
          .prepare("DELETE FROM persona_session_selections WHERE persona_id=?")
          .run(input.personaId);
      }
      const result = {
        persona: this.get(input.personaId, input.configuredAgentIds),
        clearedSessionKeys,
      };
      this.#transition(
        input.personaId,
        action,
        input.actorId,
        requestHash,
        {
          recordRevision: result.persona.recordRevision,
          clearedSelectionCount: clearedSessionKeys.length,
        },
        now,
      );
      this.#receipt(input.personaId, input.idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  delete(input: {
    personaId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
  }): { deleted: true; personaId: string } {
    const requestHash = hash(input);
    return runOpenClawStateWriteTransaction(() => {
      const replay = this.#replay<{ deleted: true; personaId: string }>(
        input.personaId,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const row = this.#requireRevision(input.personaId, input.expectedRevision);
      if (row.status !== "archived")
        throw new PersonaConflictError("Persona must be archived before deletion");
      const now = this.#now();
      this.#transition(
        input.personaId,
        "delete",
        input.actorId,
        requestHash,
        { recordRevision: input.expectedRevision },
        now,
      );
      this.#db.prepare("DELETE FROM personas WHERE persona_id=?").run(input.personaId);
      const result = { deleted: true as const, personaId: input.personaId };
      this.#receipt(input.personaId, input.idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  getSelection(sessionKey: string): PersonaSelection | undefined {
    const row = this.#db
      .prepare("SELECT * FROM persona_session_selections WHERE session_key=?")
      .get(sessionKey) as Row | undefined;
    return row ? this.#selection(row) : undefined;
  }

  setSelection(input: {
    sessionKey: string;
    personaId?: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    configuredAgentIds: ReadonlySet<string>;
  }): PersonaSelection | undefined {
    const requestHash = hash({ ...input, configuredAgentIds: undefined });
    return runOpenClawStateWriteTransaction(() => {
      const scope = `selection:${input.sessionKey}`;
      const replay = this.#replay<PersonaSelection | null>(
        scope,
        input.idempotencyKey,
        requestHash,
      );
      if (replay !== undefined) return replay ?? undefined;
      const current = this.getSelection(input.sessionKey);
      if ((current?.recordRevision ?? 0) !== input.expectedRevision)
        throw new PersonaConflictError("stale Persona selection revision");
      const now = this.#now();
      let result: PersonaSelection | undefined;
      if (!input.personaId) {
        this.#db
          .prepare("DELETE FROM persona_session_selections WHERE session_key=?")
          .run(input.sessionKey);
      } else {
        const row = this.#require(input.personaId);
        if (row.status !== "active")
          throw new PersonaConflictError("archived Persona cannot be selected");
        this.#assertReferences(row, input.configuredAgentIds);
        this.#db
          .prepare(
            "INSERT INTO persona_session_selections VALUES(?,?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET persona_id=excluded.persona_id,record_revision=excluded.record_revision,updated_at=excluded.updated_at",
          )
          .run(
            input.sessionKey,
            input.personaId,
            input.expectedRevision + 1,
            current?.createdAt ?? now,
            now,
          );
        result = this.getSelection(input.sessionKey);
      }
      this.#transition(
        input.personaId ?? current?.personaId ?? "none",
        input.personaId ? "selection_set" : "selection_clear",
        input.actorId,
        requestHash,
        { sessionKey: input.sessionKey, recordRevision: result?.recordRevision ?? 0 },
        now,
      );
      this.#receipt(scope, input.idempotencyKey, requestHash, result ?? null, now);
      return result;
    }, this.#options);
  }

  history(personaId: string, cursor = 0, limit = 50): PersonaTransition[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM persona_transitions WHERE persona_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(personaId, cursor, Math.min(100, Math.max(1, limit))) as Row[]
    ).map((row) => ({
      sequence: Number(row.sequence),
      transitionId: String(row.transition_id),
      personaId: String(row.persona_id),
      action: String(row.action) as PersonaTransitionAction,
      actorId: String(row.actor_id),
      requestHash: String(row.request_hash),
      metadata: JSON.parse(String(row.payload_json)) as PersonaTransition["metadata"],
      createdAt: Number(row.created_at),
    }));
  }

  listAgentReferences(agentId: string): string[] {
    return (
      this.#db
        .prepare(
          "SELECT persona_id FROM personas WHERE primary_agent_id=? UNION SELECT persona_id FROM persona_delegate_agents WHERE agent_id=? ORDER BY persona_id",
        )
        .all(agentId, agentId) as Row[]
    ).map((row) => String(row.persona_id));
  }

  #mutate(
    personaId: string,
    expectedRevision: number,
    idempotencyKey: string,
    requestHash: string,
    action: PersonaTransitionAction,
    actorId: string,
    configured: ReadonlySet<string>,
    apply: (row: Row, now: number) => void,
  ): Persona {
    return runOpenClawStateWriteTransaction(() => {
      const replay = this.#replay<Persona>(personaId, idempotencyKey, requestHash);
      if (replay) return replay;
      const row = this.#requireRevision(personaId, expectedRevision);
      const now = this.#now();
      apply(row, now);
      const result = this.get(personaId, configured);
      this.#transition(
        personaId,
        action,
        actorId,
        requestHash,
        { recordRevision: result.recordRevision },
        now,
      );
      this.#receipt(personaId, idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }
  #require(personaId: string): Row {
    const row = this.#db.prepare("SELECT * FROM personas WHERE persona_id=?").get(personaId) as
      | Row
      | undefined;
    if (!row) throw new PersonaNotFoundError(`Persona not found: ${personaId}`);
    return row;
  }
  #requireRevision(personaId: string, revision: number): Row {
    const row = this.#require(personaId);
    if (Number(row.record_revision) !== revision)
      throw new PersonaConflictError("stale Persona record revision");
    return row;
  }
  #delegates(personaId: string): string[] {
    return (
      this.#db
        .prepare("SELECT agent_id FROM persona_delegate_agents WHERE persona_id=? ORDER BY ordinal")
        .all(personaId) as Row[]
    ).map((row) => String(row.agent_id));
  }
  #replaceDelegates(personaId: string, delegates: readonly string[]) {
    this.#db.prepare("DELETE FROM persona_delegate_agents WHERE persona_id=?").run(personaId);
    const stmt = this.#db.prepare("INSERT INTO persona_delegate_agents VALUES(?,?,?)");
    delegates.forEach((id, ordinal) => stmt.run(personaId, id, ordinal));
  }
  #replaceVoiceBinding(personaId: string, ttsPersonaId: string | undefined) {
    const voiceDb = getNodeSqliteKysely<PersonaVoiceDatabase>(this.#db);
    executeSqliteQuerySync(
      this.#db,
      voiceDb.deleteFrom("persona_voice_bindings").where("persona_id", "=", personaId),
    );
    if (ttsPersonaId !== undefined) {
      executeSqliteQuerySync(
        this.#db,
        voiceDb.insertInto("persona_voice_bindings").values({
          persona_id: personaId,
          tts_persona_id: text(ttsPersonaId, "ttsPersonaId", 128).toLowerCase(),
        }),
      );
    }
  }
  #voiceBinding(personaId: string): string | undefined {
    const voiceDb = getNodeSqliteKysely<PersonaVoiceDatabase>(this.#db);
    const row = executeSqliteQueryTakeFirstSync(
      this.#db,
      voiceDb
        .selectFrom("persona_voice_bindings")
        .select("tts_persona_id")
        .where("persona_id", "=", personaId),
    );
    return row?.tts_persona_id;
  }
  #assertReferences(row: Row, configured: ReadonlySet<string>) {
    validateAgents(
      String(row.primary_agent_id),
      this.#delegates(String(row.persona_id)),
      configured,
    );
  }
  #persona(row: Row, configured: ReadonlySet<string>): Persona {
    const delegates = this.#delegates(String(row.persona_id));
    const ids = [String(row.primary_agent_id), ...delegates];
    const ttsPersonaId = this.#voiceBinding(String(row.persona_id));
    return {
      personaId: String(row.persona_id),
      slug: String(row.slug),
      displayName: String(row.display_name),
      description: String(row.description),
      status: String(row.status) as PersonaStatus,
      primaryAgentId: String(row.primary_agent_id),
      allowedDelegateAgentIds: delegates,
      activeRevisionId: String(row.active_revision_id),
      recordRevision: Number(row.record_revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      missingAgentIds: ids.filter((id) => !configured.has(id)),
      ...(ttsPersonaId ? { ttsPersonaId } : {}),
    };
  }
  #revision(row: Row): PersonaRevision {
    return {
      revisionId: String(row.revision_id),
      personaId: String(row.persona_id),
      revisionNumber: Number(row.revision_number),
      ...(row.parent_revision_id ? { parentRevisionId: String(row.parent_revision_id) } : {}),
      content: JSON.parse(String(row.content_json)) as PersonaRevisionContent,
      authorId: String(row.author_id),
      reason: String(row.reason),
      ...(row.provenance ? { provenance: String(row.provenance) } : {}),
      createdAt: Number(row.created_at),
    };
  }
  #selection(row: Row): PersonaSelection {
    return {
      sessionKey: String(row.session_key),
      personaId: String(row.persona_id),
      recordRevision: Number(row.record_revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  #replay<T>(scope: string, key: string, requestHash: string): T | undefined {
    const row = this.#db
      .prepare(
        "SELECT request_hash,result_json FROM persona_mutation_receipts WHERE scope_key=? AND idempotency_key=?",
      )
      .get(scope, key) as Row | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash)
      throw new PersonaConflictError("idempotency key was reused with a different request");
    return JSON.parse(String(row.result_json)) as T;
  }
  #receipt(scope: string, key: string, requestHash: string, result: unknown, now: number) {
    this.#db
      .prepare("INSERT INTO persona_mutation_receipts VALUES(?,?,?,?,?)")
      .run(scope, key, requestHash, JSON.stringify(result), now);
  }
  #transition(
    personaId: string,
    action: PersonaTransitionAction,
    actorId: string,
    requestHash: string,
    metadata: PersonaTransition["metadata"],
    now: number,
  ) {
    this.#db
      .prepare(
        "INSERT INTO persona_transitions(transition_id,persona_id,action,actor_id,request_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(randomUUID(), personaId, action, actorId, requestHash, JSON.stringify(metadata), now);
  }
}

export { PersonaConflictError, PersonaNotFoundError, PersonaValidationError } from "./types.js";
