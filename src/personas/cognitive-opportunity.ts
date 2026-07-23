import { createHash } from "node:crypto";
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

export const COGNITIVE_OUTPUT_KINDS = [
  "memory_candidate",
  "internal_memo",
  "project_suggestion",
  "follow_up",
  "persona_experiment_proposal",
  "no_op",
] as const;

export type CognitiveOutputKind = (typeof COGNITIVE_OUTPUT_KINDS)[number];
export type CognitiveOpportunitySource = "explicit" | "scheduled";
export type CognitiveOpportunityStatus =
  | "queued"
  | "running"
  | "waiting_review"
  | "completed"
  | "failed";

export type CognitiveOpportunity = {
  opportunityId: string;
  personaId: string;
  agentId: string;
  sessionKey: string;
  source: CognitiveOpportunitySource;
  status: CognitiveOpportunityStatus;
  outputKind?: CognitiveOutputKind;
  outputSummary?: string;
  taskFlowId?: string;
  approvalRequestId?: string;
  recordRevision: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

type Options = OpenClawStateDatabaseOptions & { now?: () => number };
type Database = Pick<OpenClawStateKyselyDatabase, "persona_cognitive_opportunities">;
type Row = Selectable<OpenClawStateKyselyDatabase["persona_cognitive_opportunities"]>;

export class CognitiveOpportunityConflictError extends Error {}
export class CognitiveOpportunityNotFoundError extends Error {}
export class CognitiveOpportunityValidationError extends Error {}

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
    throw new CognitiveOpportunityValidationError(`${label} must be 1-${max} characters`);
  }
  return normalized;
}

function database(db: DatabaseSync) {
  return getNodeSqliteKysely<Database>(db);
}

export class CognitiveOpportunityRepository {
  readonly #options: OpenClawStateDatabaseOptions;
  readonly #now: () => number;

  constructor(options: Options = {}) {
    this.#options = { env: options.env, path: options.path };
    this.#now = options.now ?? Date.now;
    openOpenClawStateDatabase(this.#options);
  }

  list(personaId: string, limit = 20): CognitiveOpportunity[] {
    const { db } = openOpenClawStateDatabase(this.#options);
    return executeSqliteQuerySync(
      db,
      database(db)
        .selectFrom("persona_cognitive_opportunities")
        .selectAll()
        .where("persona_id", "=", requiredText(personaId, "personaId", 128))
        .orderBy("updated_at", "desc")
        .limit(Math.max(1, Math.min(100, Math.floor(limit)))),
    ).rows.map((row) => this.#record(row));
  }

  create(input: {
    opportunityId: string;
    personaId: string;
    agentId: string;
    sessionKey: string;
    source: CognitiveOpportunitySource;
    idempotencyKey: string;
    output?: { kind: CognitiveOutputKind; summary: string };
  }): CognitiveOpportunity {
    const opportunityId = requiredText(input.opportunityId, "opportunityId", 128);
    const personaId = requiredText(input.personaId, "personaId", 128);
    const agentId = requiredText(input.agentId, "agentId", 64);
    const sessionKey = requiredText(input.sessionKey, "sessionKey", 512);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
    const requestHash = hash({
      personaId,
      agentId,
      sessionKey,
      source: input.source,
      output: input.output,
    });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = executeSqliteQueryTakeFirstSync(
        db,
        database(db)
          .selectFrom("persona_cognitive_opportunities")
          .selectAll()
          .where("persona_id", "=", personaId)
          .where("idempotency_key", "=", idempotencyKey),
      );
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw new CognitiveOpportunityConflictError(
            "idempotency key was already used for a different cognitive opportunity",
          );
        }
        return this.#record(replay);
      }
      const now = this.#now();
      const row = {
        opportunity_id: opportunityId,
        persona_id: personaId,
        agent_id: agentId,
        session_key: sessionKey,
        source: input.source,
        status: "queued",
        output_kind: null,
        output_summary: null,
        task_flow_id: null,
        approval_request_id: null,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        record_revision: 1,
        created_at: now,
        updated_at: now,
        completed_at: null,
      } as const;
      executeSqliteQuerySync(
        db,
        database(db).insertInto("persona_cognitive_opportunities").values(row),
      );
      return this.#record(row);
    }, this.#options);
  }

  update(
    opportunityId: string,
    expectedRevision: number,
    patch: {
      status: CognitiveOpportunityStatus;
      taskFlowId?: string;
      output?: { kind: CognitiveOutputKind; summary: string };
      approvalRequestId?: string;
    },
  ): CognitiveOpportunity {
    const now = this.#now();
    const completedAt = patch.status === "completed" || patch.status === "failed" ? now : null;
    return runOpenClawStateWriteTransaction(({ db }) => {
      const result = executeSqliteQueryTakeFirstSync(
        db,
        database(db)
          .updateTable("persona_cognitive_opportunities")
          .set({
            status: patch.status,
            ...(patch.taskFlowId === undefined
              ? {}
              : { task_flow_id: requiredText(patch.taskFlowId, "taskFlowId", 128) }),
            ...(patch.output === undefined
              ? {}
              : {
                  output_kind: patch.output.kind,
                  output_summary: requiredText(patch.output.summary, "output summary", 4_000),
                }),
            ...(patch.approvalRequestId === undefined
              ? {}
              : {
                  approval_request_id: requiredText(
                    patch.approvalRequestId,
                    "approvalRequestId",
                    128,
                  ),
                }),
            record_revision: expectedRevision + 1,
            updated_at: now,
            completed_at: completedAt,
          })
          .where("opportunity_id", "=", requiredText(opportunityId, "opportunityId", 128))
          .where("record_revision", "=", expectedRevision)
          .returningAll(),
      );
      if (!result) {
        const current = executeSqliteQueryTakeFirstSync(
          db,
          database(db)
            .selectFrom("persona_cognitive_opportunities")
            .select("record_revision")
            .where("opportunity_id", "=", opportunityId),
        );
        if (!current) {
          throw new CognitiveOpportunityNotFoundError(
            `cognitive opportunity not found: ${opportunityId}`,
          );
        }
        throw new CognitiveOpportunityConflictError(
          `stale cognitive opportunity revision: expected ${expectedRevision}, found ${current.record_revision}`,
        );
      }
      return this.#record(result);
    }, this.#options);
  }

  #record(row: Row): CognitiveOpportunity {
    return {
      opportunityId: row.opportunity_id,
      personaId: row.persona_id,
      agentId: row.agent_id,
      sessionKey: row.session_key,
      source: row.source as CognitiveOpportunitySource,
      status: row.status as CognitiveOpportunityStatus,
      ...(row.output_kind ? { outputKind: row.output_kind as CognitiveOutputKind } : {}),
      ...(row.output_summary ? { outputSummary: row.output_summary } : {}),
      ...(row.task_flow_id ? { taskFlowId: row.task_flow_id } : {}),
      ...(row.approval_request_id ? { approvalRequestId: row.approval_request_id } : {}),
      recordRevision: row.record_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  }
}
