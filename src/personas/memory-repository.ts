import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
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
  PersonaMemoryConflictError,
  PersonaMemoryNotFoundError,
  PersonaMemoryValidationError,
  type PersonaMemoryConflictStatus,
  type PersonaMemoryProvenance,
  type PersonaMemoryRecord,
  type PersonaMemoryRevision,
  type PersonaMemorySensitivity,
} from "./memory-types.js";

type Options = OpenClawStateDatabaseOptions & { now?: () => number };
type Database = Pick<
  OpenClawStateKyselyDatabase,
  "persona_memory_records" | "persona_memory_revisions" | "persona_memory_mutation_receipts"
>;
type RecordRow = Selectable<OpenClawStateKyselyDatabase["persona_memory_records"]>;
type ReceiptRow = Pick<
  Selectable<OpenClawStateKyselyDatabase["persona_memory_mutation_receipts"]>,
  "request_hash" | "result_json"
>;
type RevisionRow = Selectable<OpenClawStateKyselyDatabase["persona_memory_revisions"]>;

export type PersonaMemoryWrite = {
  key: string;
  content: string;
  provenance: PersonaMemoryProvenance;
  confidence: number;
  sensitivity: PersonaMemorySensitivity;
  validFrom?: number;
  validUntil?: number;
  expiresAt?: number;
  conflictStatus?: PersonaMemoryConflictStatus;
  reason: string;
  idempotencyKey: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) {
    throw new PersonaMemoryValidationError(`${label} must be 1-${max} characters`);
  }
  return normalized;
}

function validateWrite(input: PersonaMemoryWrite, now: number) {
  const confidence = input.confidence;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new PersonaMemoryValidationError("confidence must be between 0 and 1");
  }
  const validFrom = input.validFrom ?? now;
  if (input.validUntil !== undefined && input.validUntil <= validFrom) {
    throw new PersonaMemoryValidationError("validUntil must be after validFrom");
  }
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    throw new PersonaMemoryValidationError("expiresAt must be in the future");
  }
  return {
    key: requiredText(input.key, "key", 160),
    content: requiredText(input.content, "content", 8_000),
    reason: requiredText(input.reason, "reason", 500),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", 200),
    confidence,
    sensitivity: input.sensitivity,
    validFrom,
    validUntil: input.validUntil ?? null,
    expiresAt: input.expiresAt ?? null,
    conflictStatus: input.conflictStatus ?? "clear",
    provenanceJson: JSON.stringify(input.provenance),
  };
}

function getKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<Database>(db);
}

export class PersonaMemoryRepository {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #now: () => number;

  constructor(options: Options = {}) {
    this.#options = { env: options.env, path: options.path };
    this.#now = options.now ?? Date.now;
    openOpenClawStateDatabase(this.#options);
  }

  list(personaId: string, options: { query?: string; includeInvalid?: boolean } = {}) {
    const now = this.#now();
    const { db } = openOpenClawStateDatabase(this.#options);
    let query = getKysely(db)
      .selectFrom("persona_memory_records")
      .selectAll()
      .where("persona_id", "=", personaId);
    if (!options.includeInvalid) {
      query = query
        .where("valid_from", "<=", now)
        .where((builder) =>
          builder.or([builder("valid_until", "is", null), builder("valid_until", ">", now)]),
        )
        .where((builder) =>
          builder.or([builder("expires_at", "is", null), builder("expires_at", ">", now)]),
        );
    }
    const search = options.query?.trim();
    if (search) {
      query = query.where((builder) =>
        builder.or([
          builder("memory_key", "like", `%${search}%`),
          builder("content", "like", `%${search}%`),
        ]),
      );
    }
    return executeSqliteQuerySync(db, query.orderBy("updated_at", "desc")).rows.map((row) =>
      this.#record(row),
    );
  }

  get(personaId: string, recordId: string): PersonaMemoryRecord {
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getKysely(db)
        .selectFrom("persona_memory_records")
        .selectAll()
        .where("persona_id", "=", personaId)
        .where("record_id", "=", recordId),
    );
    if (!row) throw new PersonaMemoryNotFoundError(`Persona memory not found: ${recordId}`);
    return this.#record(row);
  }

  create(personaId: string, input: PersonaMemoryWrite): PersonaMemoryRecord {
    const now = this.#now();
    const normalized = validateWrite(input, now);
    const requestHash = hash({ personaId, input: normalized });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#replay(db, personaId, normalized.idempotencyKey, requestHash);
      if (replay) return replay;
      const recordId = randomUUID();
      const revisionId = randomUUID();
      const record = {
        record_id: recordId,
        persona_id: personaId,
        memory_key: normalized.key,
        content: normalized.content,
        provenance_json: normalized.provenanceJson,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        valid_from: normalized.validFrom,
        valid_until: normalized.validUntil,
        expires_at: normalized.expiresAt,
        conflict_status: normalized.conflictStatus,
        record_revision: 1,
        current_revision_id: revisionId,
        created_at: now,
        updated_at: now,
      };
      try {
        executeSqliteQuerySync(
          db,
          getKysely(db).insertInto("persona_memory_records").values(record),
        );
      } catch (error) {
        throw new PersonaMemoryConflictError(
          `Persona memory key is already in use: ${normalized.key}`,
          { cause: error },
        );
      }
      this.#insertRevision(db, record, revisionId, normalized.reason);
      const result = this.#record(record);
      this.#receipt(db, personaId, normalized.idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  correct(
    personaId: string,
    recordId: string,
    expectedRevision: number,
    input: PersonaMemoryWrite,
  ): PersonaMemoryRecord {
    const now = this.#now();
    const normalized = validateWrite(input, now);
    const requestHash = hash({ personaId, recordId, expectedRevision, input: normalized });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#replay(db, personaId, normalized.idempotencyKey, requestHash);
      if (replay) return replay;
      const current = this.get(personaId, recordId);
      if (current.recordRevision !== expectedRevision) {
        throw new PersonaMemoryConflictError(
          `stale Persona memory revision: expected ${expectedRevision}, found ${current.recordRevision}`,
        );
      }
      const revisionId = randomUUID();
      const nextRevision = current.recordRevision + 1;
      const update = {
        memory_key: normalized.key,
        content: normalized.content,
        provenance_json: normalized.provenanceJson,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        valid_from: normalized.validFrom,
        valid_until: normalized.validUntil,
        expires_at: normalized.expiresAt,
        conflict_status: normalized.conflictStatus,
        record_revision: nextRevision,
        current_revision_id: revisionId,
        updated_at: now,
      };
      const result = executeSqliteQueryTakeFirstSync(
        db,
        getKysely(db)
          .updateTable("persona_memory_records")
          .set(update)
          .where("record_id", "=", recordId)
          .where("persona_id", "=", personaId)
          .where("record_revision", "=", expectedRevision)
          .returningAll(),
      );
      if (!result) throw new PersonaMemoryConflictError("Persona memory changed concurrently");
      this.#insertRevision(db, result, revisionId, normalized.reason);
      const projected = this.#record(result);
      this.#receipt(db, personaId, normalized.idempotencyKey, requestHash, projected, now);
      return projected;
    }, this.#options);
  }

  delete(
    personaId: string,
    recordId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): { deleted: true; recordId: string } {
    const key = requiredText(idempotencyKey, "idempotencyKey", 200);
    const requestHash = hash({ personaId, recordId, expectedRevision });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#replay<{ deleted: true; recordId: string }>(
        db,
        personaId,
        key,
        requestHash,
      );
      if (replay) return replay;
      const result = executeSqliteQuerySync(
        db,
        getKysely(db)
          .deleteFrom("persona_memory_records")
          .where("persona_id", "=", personaId)
          .where("record_id", "=", recordId)
          .where("record_revision", "=", expectedRevision),
      );
      if (Number(result.numAffectedRows ?? 0) !== 1) {
        throw new PersonaMemoryConflictError("Persona memory changed or no longer exists");
      }
      const deleted = { deleted: true as const, recordId };
      this.#receipt(db, personaId, key, requestHash, deleted, this.#now());
      return deleted;
    }, this.#options);
  }

  exportJson(personaId: string): string {
    const memories = this.list(personaId, { includeInvalid: true });
    return JSON.stringify(
      {
        personaId,
        memories: memories.map((memory) => ({
          ...memory,
          revisions: this.listRevisions(memory.recordId),
        })),
      },
      null,
      2,
    );
  }

  listRevisions(recordId: string): PersonaMemoryRevision[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      getKysely(db)
        .selectFrom("persona_memory_revisions")
        .selectAll()
        .where("record_id", "=", recordId)
        .orderBy("revision_number", "desc"),
    ).rows.map((row) => this.#revision(row));
  }

  #record(row: RecordRow): PersonaMemoryRecord {
    return {
      recordId: row.record_id,
      personaId: row.persona_id,
      key: row.memory_key,
      content: row.content,
      provenance: JSON.parse(row.provenance_json) as PersonaMemoryProvenance,
      confidence: row.confidence,
      sensitivity: row.sensitivity as PersonaMemorySensitivity,
      validFrom: row.valid_from,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      conflictStatus: row.conflict_status as PersonaMemoryConflictStatus,
      recordRevision: row.record_revision,
      currentRevisionId: row.current_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #insertRevision(db: DatabaseSync, row: RecordRow, revisionId: string, reason: string) {
    executeSqliteQuerySync(
      db,
      getKysely(db).insertInto("persona_memory_revisions").values({
        revision_id: revisionId,
        record_id: row.record_id,
        revision_number: row.record_revision,
        content: row.content,
        provenance_json: row.provenance_json,
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
        expires_at: row.expires_at,
        conflict_status: row.conflict_status,
        reason,
        created_at: row.updated_at,
      }),
    );
  }

  #revision(row: RevisionRow): PersonaMemoryRevision {
    return {
      revisionId: row.revision_id,
      recordId: row.record_id,
      revisionNumber: row.revision_number,
      content: row.content,
      provenance: JSON.parse(row.provenance_json) as PersonaMemoryProvenance,
      confidence: row.confidence,
      sensitivity: row.sensitivity as PersonaMemorySensitivity,
      validFrom: row.valid_from,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      conflictStatus: row.conflict_status as PersonaMemoryConflictStatus,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  #replay<T = PersonaMemoryRecord>(
    db: DatabaseSync,
    personaId: string,
    key: string,
    requestHash: string,
  ): T | undefined {
    const receipt = executeSqliteQueryTakeFirstSync<ReceiptRow>(
      db,
      getKysely(db)
        .selectFrom("persona_memory_mutation_receipts")
        .select(["request_hash", "result_json"])
        .where("persona_id", "=", personaId)
        .where("idempotency_key", "=", key),
    );
    if (!receipt) return undefined;
    if (receipt.request_hash !== requestHash) {
      throw new PersonaMemoryConflictError("idempotency key was reused with different input");
    }
    return JSON.parse(receipt.result_json) as T;
  }

  #receipt(
    db: DatabaseSync,
    personaId: string,
    key: string,
    requestHash: string,
    result: unknown,
    now: number,
  ) {
    executeSqliteQuerySync(
      db,
      getKysely(db)
        .insertInto("persona_memory_mutation_receipts")
        .values({
          persona_id: personaId,
          idempotency_key: key,
          request_hash: requestHash,
          result_json: JSON.stringify(result),
          created_at: now,
        }),
    );
  }
}
