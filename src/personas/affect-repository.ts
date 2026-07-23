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
  applyPersonaExperimentPatch,
  derivePersonaAffectSnapshot,
  validatePersonaExperimentPatch,
} from "./affect.js";
import { PersonaRepository } from "./repository.js";
import {
  PERSONA_AFFECT_DIMENSIONS,
  PERSONA_AFFECT_EVIDENCE_KINDS,
  PERSONA_EXPERIMENT_EVIDENCE_KINDS,
  PersonaConflictError,
  PersonaNotFoundError,
  PersonaValidationError,
  type PersonaAffectDimension,
  type PersonaAffectEvidence,
  type PersonaAffectImpulse,
  type PersonaExperimentEvidenceKind,
  type PersonaExperimentPatch,
  type PersonaExperimentProposal,
  type PersonaRevision,
} from "./types.js";

type Options = OpenClawStateDatabaseOptions & { now?: () => number };
type Database = Pick<
  OpenClawStateKyselyDatabase,
  | "personas"
  | "persona_revisions"
  | "persona_affect_impulses"
  | "persona_experiments"
  | "persona_mutation_receipts"
>;
type ImpulseRow = Selectable<OpenClawStateKyselyDatabase["persona_affect_impulses"]>;
type ExperimentRow = Selectable<OpenClawStateKyselyDatabase["persona_experiments"]>;
type ReceiptRow = Pick<
  Selectable<OpenClawStateKyselyDatabase["persona_mutation_receipts"]>,
  "request_hash" | "result_json"
>;

const MAX_EVIDENCE = 16;
const MAX_DELTA = 10_000;
const MIN_HALF_LIFE_MS = 1_000;
const MAX_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_REVISION_REASON_LENGTH = 500;

function database(db: DatabaseSync) {
  return getNodeSqliteKysely<Database>(db);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
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

function text(value: string, label: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) {
    throw new PersonaValidationError(`${label} must be 1-${max} characters`);
  }
  return normalized;
}

function validateEvidence(
  evidence: readonly { kind: string; referenceId: string }[],
  allowedKinds: ReadonlySet<string>,
): Array<{ kind: string; referenceId: string }> {
  if (evidence.length === 0 || evidence.length > MAX_EVIDENCE) {
    throw new PersonaValidationError(`evidence must contain 1-${MAX_EVIDENCE} entries`);
  }
  return evidence.map((entry) => {
    if (!allowedKinds.has(entry.kind)) {
      throw new PersonaValidationError(`evidence kind is not allowlisted: ${entry.kind}`);
    }
    return { kind: entry.kind, referenceId: text(entry.referenceId, "referenceId", 128) };
  });
}

export class PersonaAffectRepository {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #now: () => number;

  constructor(options: Options = {}) {
    this.#options = { env: options.env, path: options.path };
    this.#now = options.now ?? Date.now;
    openOpenClawStateDatabase(this.#options);
  }

  snapshot(personaId: string, evaluatedAt = this.#now()) {
    const { db } = openOpenClawStateDatabase(this.#options);
    const persona = executeSqliteQueryTakeFirstSync(
      db,
      database(db)
        .selectFrom("personas")
        .innerJoin(
          "persona_revisions",
          "persona_revisions.revision_id",
          "personas.active_revision_id",
        )
        .select([
          "personas.persona_id",
          "personas.active_revision_id",
          "persona_revisions.content_json",
        ])
        .where("personas.persona_id", "=", text(personaId, "personaId", 128)),
    );
    if (!persona) {
      throw new PersonaNotFoundError(`Persona not found: ${personaId}`);
    }
    const impulses = executeSqliteQuerySync(
      db,
      database(db)
        .selectFrom("persona_affect_impulses")
        .selectAll()
        .where("persona_id", "=", personaId)
        .where("persona_revision_id", "=", persona.active_revision_id)
        .orderBy("sequence"),
    ).rows.map((row) => this.#impulse(row));
    return derivePersonaAffectSnapshot({
      personaId,
      personaRevisionId: persona.active_revision_id,
      content: JSON.parse(persona.content_json),
      impulses,
      evaluatedAt,
    });
  }

  appendImpulse(input: {
    personaId: string;
    operation: "apply" | "retract";
    targetImpulseId?: string;
    dimension?: PersonaAffectDimension;
    delta?: number;
    halfLifeMs?: number;
    reason: PersonaAffectImpulse["reason"];
    source: PersonaAffectImpulse["source"];
    evidence: PersonaAffectEvidence[];
    expiresAt?: number;
    actorId: string;
    idempotencyKey: string;
  }): { impulse: PersonaAffectImpulse; affect: ReturnType<PersonaAffectRepository["snapshot"]> } {
    const now = this.#now();
    const personaId = text(input.personaId, "personaId", 128);
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 128);
    const evidence = validateEvidence(
      input.evidence,
      new Set(PERSONA_AFFECT_EVIDENCE_KINDS),
    ) as PersonaAffectEvidence[];
    const requestHash = hash({ ...input, evidence });
    const impulse = runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#replay<PersonaAffectImpulse>(
        db,
        `affect:${personaId}`,
        idempotencyKey,
        requestHash,
      );
      if (replay) {
        return replay;
      }
      const persona = executeSqliteQueryTakeFirstSync(
        db,
        database(db)
          .selectFrom("personas")
          .select(["persona_id", "active_revision_id"])
          .where("persona_id", "=", personaId),
      );
      if (!persona) {
        throw new PersonaNotFoundError(`Persona not found: ${personaId}`);
      }
      if (input.expiresAt !== undefined && input.expiresAt <= now) {
        throw new PersonaValidationError("expiresAt must be in the future");
      }
      const row =
        input.operation === "apply"
          ? this.#applyRow(input, personaId, persona.active_revision_id, evidence, now)
          : this.#retractionRow(db, input, personaId, persona.active_revision_id, evidence, now);
      const inserted = executeSqliteQueryTakeFirstSync(
        db,
        database(db).insertInto("persona_affect_impulses").values(row).returningAll(),
      );
      if (!inserted) {
        throw new PersonaConflictError("failed to record Persona affect impulse");
      }
      const result = this.#impulse(inserted);
      this.#receipt(db, `affect:${personaId}`, idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
    return { impulse, affect: this.snapshot(personaId, now) };
  }

  listExperiments(personaId: string): PersonaExperimentProposal[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      database(db)
        .selectFrom("persona_experiments")
        .selectAll()
        .where("persona_id", "=", text(personaId, "personaId", 128))
        .orderBy("created_at", "desc"),
    ).rows.map((row) => this.#experiment(row));
  }

  proposeExperiment(input: {
    personaId: string;
    hypothesis: string;
    patch: PersonaExperimentPatch;
    evidence: Array<{ kind: PersonaExperimentEvidenceKind; referenceId: string }>;
    proposerId: string;
    idempotencyKey: string;
  }): PersonaExperimentProposal {
    const personaId = text(input.personaId, "personaId", 128);
    const hypothesis = text(input.hypothesis, "hypothesis", 500);
    const patch = validatePersonaExperimentPatch(input.patch);
    const evidence = validateEvidence(
      input.evidence,
      new Set(PERSONA_EXPERIMENT_EVIDENCE_KINDS),
    ) as Array<{ kind: PersonaExperimentEvidenceKind; referenceId: string }>;
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 128);
    const requestHash = hash({ personaId, hypothesis, patch, evidence });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#replay<PersonaExperimentProposal>(
        db,
        `experiment:${personaId}`,
        idempotencyKey,
        requestHash,
      );
      if (replay) {
        return replay;
      }
      const persona = executeSqliteQueryTakeFirstSync(
        db,
        database(db)
          .selectFrom("personas")
          .select("active_revision_id")
          .where("persona_id", "=", personaId),
      );
      if (!persona) {
        throw new PersonaNotFoundError(`Persona not found: ${personaId}`);
      }
      const now = this.#now();
      const row = {
        experiment_id: randomUUID(),
        persona_id: personaId,
        base_revision_id: persona.active_revision_id,
        status: "proposed",
        hypothesis,
        patch_json: JSON.stringify(patch),
        evidence_json: JSON.stringify(evidence),
        proposer_id: text(input.proposerId, "proposerId", 120),
        created_at: now,
        decided_at: null,
        decided_by: null,
        accepted_revision_id: null,
      } as const;
      executeSqliteQuerySync(db, database(db).insertInto("persona_experiments").values(row));
      const result = this.#experiment(row);
      this.#receipt(db, `experiment:${personaId}`, idempotencyKey, requestHash, result, now);
      return result;
    }, this.#options);
  }

  acceptExperiment(input: {
    personaId: string;
    experimentId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
    configuredAgentIds: ReadonlySet<string>;
  }): {
    persona: ReturnType<PersonaRepository["get"]>;
    revision: PersonaRevision;
    experiment: PersonaExperimentProposal;
  } {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const experiment = this.listExperiments(input.personaId).find(
        (candidate) => candidate.experimentId === input.experimentId,
      );
      if (!experiment) {
        throw new PersonaNotFoundError(`Persona experiment not found: ${input.experimentId}`);
      }
      const repository = new PersonaRepository(this.#options);
      if (experiment.status === "accepted" && experiment.acceptedRevisionId) {
        return {
          persona: repository.get(input.personaId, input.configuredAgentIds),
          revision: repository.getRevision(experiment.acceptedRevisionId),
          experiment,
        };
      }
      const persona = repository.get(input.personaId, input.configuredAgentIds);
      if (persona.activeRevisionId !== experiment.baseRevisionId) {
        throw new PersonaConflictError("Persona experiment base revision is no longer active");
      }
      const base = repository.getRevision(experiment.baseRevisionId);
      const revised = repository.revise({
        personaId: input.personaId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        authorId: input.actorId,
        reason: `Accepted Persona experiment: ${experiment.hypothesis}`.slice(
          0,
          MAX_REVISION_REASON_LENGTH,
        ),
        provenance: `persona-experiment:${experiment.experimentId}`,
        content: applyPersonaExperimentPatch(base.content, experiment.patch),
        configuredAgentIds: input.configuredAgentIds,
      });
      const row = executeSqliteQueryTakeFirstSync(
        db,
        database(db)
          .updateTable("persona_experiments")
          .set({
            status: "accepted",
            decided_at: this.#now(),
            decided_by: text(input.actorId, "actorId", 120),
            accepted_revision_id: revised.revision.revisionId,
          })
          .where("experiment_id", "=", input.experimentId)
          .where("status", "=", "proposed")
          .returningAll(),
      );
      if (!row) {
        const current = executeSqliteQueryTakeFirstSync(
          db,
          database(db)
            .selectFrom("persona_experiments")
            .selectAll()
            .where("experiment_id", "=", input.experimentId),
        );
        if (
          !current ||
          current.status !== "accepted" ||
          current.accepted_revision_id !== revised.revision.revisionId
        ) {
          throw new PersonaConflictError("Persona experiment acceptance raced another decision");
        }
        return { ...revised, experiment: this.#experiment(current) };
      }
      return { ...revised, experiment: this.#experiment(row) };
    }, this.#options);
  }

  #applyRow(
    input: Parameters<PersonaAffectRepository["appendImpulse"]>[0],
    personaId: string,
    revisionId: string,
    evidence: PersonaAffectEvidence[],
    now: number,
  ) {
    if (!input.dimension || !PERSONA_AFFECT_DIMENSIONS.includes(input.dimension)) {
      throw new PersonaValidationError("apply impulse requires an allowlisted dimension");
    }
    if (!Number.isSafeInteger(input.delta) || Math.abs(input.delta ?? 0) > MAX_DELTA) {
      throw new PersonaValidationError(
        `delta must be an integer between -${MAX_DELTA} and ${MAX_DELTA}`,
      );
    }
    if (
      !Number.isSafeInteger(input.halfLifeMs) ||
      (input.halfLifeMs ?? 0) < MIN_HALF_LIFE_MS ||
      (input.halfLifeMs ?? 0) > MAX_HALF_LIFE_MS
    ) {
      throw new PersonaValidationError(
        `halfLifeMs must be an integer between ${MIN_HALF_LIFE_MS} and ${MAX_HALF_LIFE_MS}`,
      );
    }
    if (
      input.reason !== "interaction" &&
      input.reason !== "time_rhythm" &&
      input.reason !== "manual_override"
    ) {
      throw new PersonaValidationError("apply impulse reason is not allowlisted");
    }
    return {
      impulse_id: randomUUID(),
      persona_id: personaId,
      persona_revision_id: revisionId,
      operation: "apply",
      target_impulse_id: null,
      dimension: input.dimension,
      delta: input.delta as number,
      half_life_ms: input.halfLifeMs as number,
      reason: input.reason,
      actor_id: text(input.actorId, "actorId", 120),
      source: input.source,
      evidence_json: JSON.stringify(evidence),
      created_at: now,
      expires_at: input.expiresAt ?? null,
    } as const;
  }

  #retractionRow(
    db: DatabaseSync,
    input: Parameters<PersonaAffectRepository["appendImpulse"]>[0],
    personaId: string,
    revisionId: string,
    evidence: PersonaAffectEvidence[],
    now: number,
  ) {
    const targetImpulseId = text(input.targetImpulseId ?? "", "targetImpulseId", 128);
    if (input.reason !== "owner_correction" || input.source !== "operator") {
      throw new PersonaValidationError("retractions require an operator owner_correction");
    }
    const target = executeSqliteQueryTakeFirstSync(
      db,
      database(db)
        .selectFrom("persona_affect_impulses")
        .select(["impulse_id", "operation"])
        .where("impulse_id", "=", targetImpulseId)
        .where("persona_id", "=", personaId)
        .where("persona_revision_id", "=", revisionId),
    );
    if (!target || target.operation !== "apply") {
      throw new PersonaValidationError(
        "retraction target must be an active-revision apply impulse",
      );
    }
    const duplicate = executeSqliteQueryTakeFirstSync(
      db,
      database(db)
        .selectFrom("persona_affect_impulses")
        .select("impulse_id")
        .where("operation", "=", "retract")
        .where("target_impulse_id", "=", targetImpulseId),
    );
    if (duplicate) {
      throw new PersonaConflictError("Persona affect impulse was already retracted");
    }
    return {
      impulse_id: randomUUID(),
      persona_id: personaId,
      persona_revision_id: revisionId,
      operation: "retract",
      target_impulse_id: targetImpulseId,
      dimension: null,
      delta: null,
      half_life_ms: null,
      reason: input.reason,
      actor_id: text(input.actorId, "actorId", 120),
      source: input.source,
      evidence_json: JSON.stringify(evidence),
      created_at: now,
      expires_at: input.expiresAt ?? null,
    } as const;
  }

  #impulse(row: ImpulseRow): PersonaAffectImpulse {
    return {
      sequence: row.sequence,
      impulseId: row.impulse_id,
      personaId: row.persona_id,
      personaRevisionId: row.persona_revision_id,
      operation: row.operation as PersonaAffectImpulse["operation"],
      ...(row.target_impulse_id ? { targetImpulseId: row.target_impulse_id } : {}),
      ...(row.dimension ? { dimension: row.dimension as PersonaAffectDimension } : {}),
      ...(row.delta === null ? {} : { delta: row.delta }),
      ...(row.half_life_ms === null ? {} : { halfLifeMs: row.half_life_ms }),
      reason: row.reason as PersonaAffectImpulse["reason"],
      actorId: row.actor_id,
      source: row.source as PersonaAffectImpulse["source"],
      evidence: JSON.parse(row.evidence_json) as PersonaAffectEvidence[],
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
  }

  #experiment(row: ExperimentRow): PersonaExperimentProposal {
    return {
      experimentId: row.experiment_id,
      personaId: row.persona_id,
      baseRevisionId: row.base_revision_id,
      status: row.status as PersonaExperimentProposal["status"],
      hypothesis: row.hypothesis,
      patch: JSON.parse(row.patch_json) as PersonaExperimentPatch,
      evidence: JSON.parse(row.evidence_json) as PersonaExperimentProposal["evidence"],
      proposerId: row.proposer_id,
      createdAt: row.created_at,
      ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.accepted_revision_id ? { acceptedRevisionId: row.accepted_revision_id } : {}),
    };
  }

  #replay<T>(
    db: DatabaseSync,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
  ): T | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      database(db)
        .selectFrom("persona_mutation_receipts")
        .select(["request_hash", "result_json"])
        .where("scope_key", "=", scope)
        .where("idempotency_key", "=", idempotencyKey),
    ) as ReceiptRow | undefined;
    if (!row) {
      return undefined;
    }
    if (row.request_hash !== requestHash) {
      throw new PersonaConflictError("idempotency key was reused with a different request");
    }
    return JSON.parse(row.result_json) as T;
  }

  #receipt(
    db: DatabaseSync,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    result: unknown,
    now: number,
  ) {
    executeSqliteQuerySync(
      db,
      database(db)
        .insertInto("persona_mutation_receipts")
        .values({
          scope_key: scope,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          result_json: JSON.stringify(result),
          created_at: now,
        }),
    );
  }
}
