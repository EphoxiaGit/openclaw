import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { Value } from "typebox/value";
import {
  WorkInputRequestSchema,
  WorkInputResponseSchema,
  type WorkInputRequest,
  type WorkInputResponse,
} from "../../packages/gateway-protocol/src/schema/work-inputs.js";
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
  WorkInputConflictError,
  WorkInputNotFoundError,
  WorkInputValidationError,
  type CreateWorkInputRequest,
  type WorkInputDeliveryStatus,
  type WorkInputRecord,
  type WorkInputStatus,
} from "./types.js";

type Options = OpenClawStateDatabaseOptions & { now?: () => number };
type RequestsTable = OpenClawStateKyselyDatabase["work_input_requests"];
type TransitionsTable = OpenClawStateKyselyDatabase["work_input_request_transitions"];
type Database = Pick<
  OpenClawStateKyselyDatabase,
  "work_input_requests" | "work_input_request_transitions"
>;
type Row = Selectable<RequestsTable>;
type TransitionReplayRow = Pick<Selectable<TransitionsTable>, "request_hash" | "result_json">;

export type WorkInputListPage = {
  records: WorkInputRecord[];
  nextCursor?: number;
};

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

function requireText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new WorkInputValidationError(`${label} must be 1-${max} characters`);
  }
  return normalized;
}

function responseKeys(response: WorkInputResponse): Set<string> {
  return new Set(
    Object.entries(response)
      .filter(([, value]) =>
        typeof value === "string"
          ? value.trim().length > 0
          : Array.isArray(value)
            ? value.length > 0
            : value !== undefined,
      )
      .map(([key]) => key),
  );
}

function validateResponse(
  request: WorkInputRequest,
  response: WorkInputResponse,
): WorkInputResponse {
  const normalized = {
    ...response,
    ...(response.text !== undefined ? { text: response.text.trim() } : {}),
  };
  if (!Value.Check(WorkInputResponseSchema, normalized)) {
    throw new WorkInputValidationError("invalid work input response");
  }
  const keys = responseKeys(normalized);
  if (request.kind === "question") {
    const selected = normalized.choiceIds ?? [];
    if (selected.some((id) => !request.options.some((option) => option.id === id))) {
      throw new WorkInputValidationError("question response contains an unknown choice");
    }
    if (!request.allowMultiple && selected.length > 1) {
      throw new WorkInputValidationError("question accepts one choice");
    }
    if (!request.allowFreeText && keys.has("text")) {
      throw new WorkInputValidationError("question does not accept free text");
    }
    if ([...keys].some((key) => key !== "choiceIds" && key !== "text")) {
      throw new WorkInputValidationError("question response contains unsupported fields");
    }
  } else if (request.kind === "add_information") {
    if ([...keys].some((key) => !request.allowedFields.includes(key as never))) {
      throw new WorkInputValidationError("information response contains unsupported fields");
    }
  } else if (request.kind === "approval") {
    if (keys.size !== 1 || !keys.has("choiceIds") || normalized.choiceIds?.length !== 1) {
      throw new WorkInputValidationError("approval requires exactly one semantic decision");
    }
    if (!request.decisions.includes(normalized.choiceIds[0] as "approve" | "reject")) {
      throw new WorkInputValidationError("invalid semantic approval decision");
    }
  } else {
    if (keys.size !== 1 || !keys.has("secretRefs") || !normalized.secretRefs?.length) {
      throw new WorkInputValidationError("SecretRef request accepts locator references only");
    }
    if (
      request.providerAliases?.length &&
      normalized.secretRefs.some(
        (reference) => !request.providerAliases?.includes(reference.provider),
      )
    ) {
      throw new WorkInputValidationError("SecretRef provider is not allowed");
    }
  }
  if (keys.size === 0) {
    throw new WorkInputValidationError("response must not be empty");
  }
  return structuredClone(normalized);
}

function getKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<Database>(db);
}

export class WorkInputRepository {
  readonly #options: Options;
  readonly #now: () => number;

  constructor(options: Options = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    openOpenClawStateDatabase(options);
  }

  create(input: CreateWorkInputRequest): WorkInputRecord {
    const now = this.#now();
    const requestId = randomUUID();
    const base = {
      id: requestId,
      revision: 1,
      status: "pending" as const,
      sessionKey: requireText(input.sessionKey, "sessionKey", 512),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      prompt: requireText(input.prompt, "prompt", 2_000),
      ...(input.description ? { description: input.description.slice(0, 4_000) } : {}),
      creator: input.creator,
    };
    const request: WorkInputRequest =
      input.kind === "question"
        ? {
            ...base,
            kind: input.kind,
            options: input.options,
            allowMultiple: input.allowMultiple,
            allowFreeText: input.allowFreeText,
          }
        : input.kind === "add_information"
          ? { ...base, kind: input.kind, allowedFields: input.allowedFields }
          : input.kind === "approval"
            ? { ...base, kind: input.kind, decisions: input.decisions ?? ["approve", "reject"] }
            : {
                ...base,
                kind: input.kind,
                ...(input.providerAliases ? { providerAliases: input.providerAliases } : {}),
                ...(input.targetPaths ? { targetPaths: input.targetPaths } : {}),
              };
    if (!Value.Check(WorkInputRequestSchema, request)) {
      throw new WorkInputValidationError("invalid work input request");
    }
    const deliveryStatus = "not_applicable" as const;
    const cancelOutcome = input.cancelOutcome ?? "cancelled";
    const expiryOutcome = input.expiryOutcome ?? "cancelled";
    runOpenClawStateWriteTransaction(({ db }) => {
      const row: Insertable<RequestsTable> = {
        request_id: requestId,
        revision: 1,
        status: "pending",
        session_key: request.sessionKey,
        project_id: request.projectId ?? null,
        plan_id: request.planId ?? null,
        step_id: request.stepId ?? null,
        task_id: request.taskId ?? null,
        request_json: JSON.stringify(request),
        response_json: null,
        flow_id: input.flow?.flowId ?? null,
        flow_revision: input.flow?.expectedRevision ?? null,
        cancel_outcome: cancelOutcome,
        expiry_outcome: expiryOutcome,
        delivery_status: deliveryStatus,
        expires_at: request.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      };
      executeSqliteQuerySync(db, getKysely(db).insertInto("work_input_requests").values(row));
      this.#transition(
        requestId,
        "create",
        input.creator.label,
        null,
        hash(request),
        { request },
        now,
        db,
      );
    }, this.#options);
    return { request, deliveryStatus, cancelOutcome, expiryOutcome };
  }

  list(
    filters: {
      sessionKey?: string;
      projectId?: string;
      status?: WorkInputStatus;
      cursor?: number;
      limit?: number;
    } = {},
  ): WorkInputRecord[] {
    return this.listPage(filters).records;
  }

  listPage(
    filters: {
      sessionKey?: string;
      projectId?: string;
      status?: WorkInputStatus;
      cursor?: number;
      limit?: number;
    } = {},
  ): WorkInputListPage {
    this.expirePending();
    const limit = filters.limit ?? 50;
    const { db } = openOpenClawStateDatabase(this.#options);
    const query = getKysely(db)
      .selectFrom("work_input_requests")
      .selectAll()
      .$if(filters.sessionKey !== undefined, (builder) =>
        builder.where("session_key", "=", filters.sessionKey as string),
      )
      .$if(filters.projectId !== undefined, (builder) =>
        builder.where("project_id", "=", filters.projectId as string),
      )
      .$if(filters.status !== undefined, (builder) =>
        builder.where("status", "=", filters.status as string),
      )
      .$if(filters.cursor !== undefined, (builder) =>
        builder.where("sequence", "<", filters.cursor as number),
      )
      .orderBy("sequence", "desc")
      .limit(limit + 1);
    const rows = executeSqliteQuerySync(db, query).rows;
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? Number(pageRows.at(-1)?.sequence) : undefined;
    return {
      records: pageRows.map((row) => this.#record(row)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  get(requestId: string): WorkInputRecord {
    this.expirePending(requestId);
    const { db } = openOpenClawStateDatabase(this.#options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getKysely(db)
        .selectFrom("work_input_requests")
        .selectAll()
        .where("request_id", "=", requestId),
    );
    if (!row) {
      throw new WorkInputNotFoundError(`Work input not found: ${requestId}`);
    }
    return this.#record(row);
  }

  resolve(input: {
    requestId: string;
    expectedRevision: number;
    idempotencyKey: string;
    response: WorkInputResponse;
    actorId: string;
  }): WorkInputRecord {
    const current = this.get(input.requestId);
    const response = validateResponse(current.request, input.response);
    return this.#terminal(input, "resolved", response);
  }

  replayResolve(input: {
    requestId: string;
    idempotencyKey: string;
    response: WorkInputResponse;
  }): WorkInputRecord | undefined {
    const current = this.get(input.requestId);
    const response = validateResponse(current.request, input.response);
    const requestHash = hash({ status: "resolved", response });
    const { db } = openOpenClawStateDatabase(this.#options);
    const replay = this.#transitionReplay(db, input.requestId, input.idempotencyKey);
    if (!replay) {
      return undefined;
    }
    if (replay.request_hash !== requestHash) {
      throw new WorkInputConflictError("idempotency key reused with different payload");
    }
    return current;
  }

  cancel(input: {
    requestId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorId: string;
  }): WorkInputRecord {
    return this.#terminal(input, "cancelled");
  }

  deliveryCandidates(): WorkInputRecord[] {
    this.expirePending();
    const { db } = openOpenClawStateDatabase(this.#options);
    const rows = executeSqliteQuerySync(
      db,
      getKysely(db)
        .selectFrom("work_input_requests")
        .selectAll()
        .where("delivery_status", "in", ["pending", "failed"])
        .orderBy("sequence", "asc")
        .limit(100),
    ).rows;
    return rows.map((row) => this.#record(row));
  }

  markDelivery(
    requestId: string,
    status: Extract<WorkInputDeliveryStatus, "applied" | "failed">,
  ): void {
    const { db } = openOpenClawStateDatabase(this.#options);
    executeSqliteQuerySync(
      db,
      getKysely(db)
        .updateTable("work_input_requests")
        .set({ delivery_status: status, updated_at: this.#now() })
        .where("request_id", "=", requestId)
        .where("delivery_status", "in", ["pending", "failed"]),
    );
  }

  expirePending(requestId?: string): WorkInputRecord[] {
    const now = this.#now();
    return runOpenClawStateWriteTransaction(({ db }) => {
      const expired: WorkInputRecord[] = [];
      const rows = executeSqliteQuerySync(
        db,
        getKysely(db)
          .selectFrom("work_input_requests")
          .selectAll()
          .where("status", "=", "pending")
          .where("expires_at", "is not", null)
          .where("expires_at", "<=", now)
          .$if(requestId !== undefined, (builder) =>
            builder.where("request_id", "=", requestId as string),
          ),
      ).rows;
      for (const row of rows) {
        const revision = Number(row.revision) + 1;
        const deliveryStatus = row.flow_id ? "pending" : "not_applicable";
        const updated = executeSqliteQuerySync(
          db,
          getKysely(db)
            .updateTable("work_input_requests")
            .set({
              status: "expired",
              revision,
              delivery_status: deliveryStatus,
              updated_at: now,
            })
            .where("request_id", "=", row.request_id)
            .where("status", "=", "pending"),
        );
        if (updated.numAffectedRows === 0n) {
          continue;
        }
        this.#transition(
          row.request_id,
          "expired",
          "system",
          null,
          hash({ status: "expired" }),
          { requestId: row.request_id, revision, status: "expired" },
          now,
          db,
        );
        expired.push(
          this.#record({
            ...row,
            status: "expired",
            revision,
            delivery_status: deliveryStatus,
            updated_at: now,
          }),
        );
      }
      return expired;
    }, this.#options);
  }

  #terminal(
    input: { requestId: string; expectedRevision: number; idempotencyKey: string; actorId: string },
    status: "resolved" | "cancelled",
    response?: WorkInputResponse,
  ): WorkInputRecord {
    const requestHash = hash({ status, response });
    return runOpenClawStateWriteTransaction(({ db }) => {
      const replay = this.#transitionReplay(db, input.requestId, input.idempotencyKey);
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw new WorkInputConflictError("idempotency key reused with different payload");
        }
        return JSON.parse(replay.result_json) as WorkInputRecord;
      }
      const current = executeSqliteQueryTakeFirstSync(
        db,
        getKysely(db)
          .selectFrom("work_input_requests")
          .selectAll()
          .where("request_id", "=", input.requestId),
      );
      if (!current) {
        throw new WorkInputNotFoundError(`Work input not found: ${input.requestId}`);
      }
      if (current.status !== "pending" || Number(current.revision) !== input.expectedRevision) {
        throw new WorkInputConflictError("stale or terminal work input request");
      }
      const nextRevision = input.expectedRevision + 1;
      const deliveryStatus = current.flow_id ? "pending" : "not_applicable";
      const now = this.#now();
      const updated = executeSqliteQuerySync(
        db,
        getKysely(db)
          .updateTable("work_input_requests")
          .set({
            status,
            revision: nextRevision,
            response_json: response ? JSON.stringify(response) : null,
            delivery_status: deliveryStatus,
            updated_at: now,
          })
          .where("request_id", "=", input.requestId)
          .where("revision", "=", input.expectedRevision)
          .where("status", "=", "pending"),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new WorkInputConflictError("stale or terminal work input request");
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        getKysely(db)
          .selectFrom("work_input_requests")
          .selectAll()
          .where("request_id", "=", input.requestId),
      );
      if (!row) {
        throw new WorkInputNotFoundError(`Work input not found: ${input.requestId}`);
      }
      const result = this.#record(row);
      this.#transition(
        input.requestId,
        status,
        input.actorId,
        input.idempotencyKey,
        requestHash,
        result,
        now,
        db,
      );
      return result;
    }, this.#options);
  }

  #record(row: Row): WorkInputRecord {
    const stored = JSON.parse(row.request_json) as WorkInputRequest;
    const request = {
      ...stored,
      revision: Number(row.revision),
      status: row.status as WorkInputStatus,
      updatedAt: Number(row.updated_at),
    } as WorkInputRequest;
    return {
      request,
      ...(row.response_json
        ? { response: JSON.parse(row.response_json) as WorkInputResponse }
        : {}),
      ...(row.flow_id ? { flowId: row.flow_id, flowRevision: Number(row.flow_revision) } : {}),
      deliveryStatus: row.delivery_status as WorkInputDeliveryStatus,
      cancelOutcome: row.cancel_outcome as WorkInputRecord["cancelOutcome"],
      expiryOutcome: row.expiry_outcome as WorkInputRecord["expiryOutcome"],
    };
  }

  #transitionReplay(
    db: DatabaseSync,
    requestId: string,
    idempotencyKey: string,
  ): TransitionReplayRow | undefined {
    return executeSqliteQueryTakeFirstSync<TransitionReplayRow>(
      db,
      getKysely(db)
        .selectFrom("work_input_request_transitions")
        .select(["request_hash", "result_json"])
        .where("request_id", "=", requestId)
        .where("idempotency_key", "=", idempotencyKey),
    );
  }

  #transition(
    requestId: string,
    action: string,
    actorId: string,
    idempotencyKey: string | null,
    requestHash: string,
    result: unknown,
    now: number,
    db: DatabaseSync,
  ): void {
    const row: Insertable<TransitionsTable> = {
      transition_id: randomUUID(),
      request_id: requestId,
      action,
      actor_id: actorId.slice(0, 120),
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      result_json: JSON.stringify(result),
      created_at: now,
    };
    executeSqliteQuerySync(
      db,
      getKysely(db).insertInto("work_input_request_transitions").values(row),
    );
  }
}
