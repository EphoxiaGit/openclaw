import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { WorkInputRepository } from "./repository.js";
import { WorkInputConflictError } from "./types.js";

const dirs: string[] = [];
afterEach(() => closeOpenClawStateDatabaseForTest());
afterAll(() => cleanupTempDirs(dirs));

describe("WorkInputRepository", () => {
  it("persists strict responses and applies CAS/idempotency once across restart", () => {
    const dbPath = path.join(makeTempDir(dirs, "work-inputs-"), "state.sqlite");
    const repository = new WorkInputRepository({ path: dbPath, now: () => 100 });
    const created = repository.create({
      kind: "secret_ref",
      sessionKey: "agent:main:main",
      prompt: "Select credential",
      creator: { type: "system", label: "TaskFlow" },
      providerAliases: ["default"],
    });
    const input = {
      requestId: created.request.id,
      expectedRevision: 1,
      idempotencyKey: "answer-once",
      actorId: "device:test",
      response: { secretRefs: [{ source: "env" as const, provider: "default", id: "TOKEN" }] },
    };
    const resolved = repository.resolve(input);
    expect(repository.resolve(input)).toEqual(resolved);
    expect(() => repository.cancel({ ...input, idempotencyKey: "different" })).toThrow(
      WorkInputConflictError,
    );
    closeOpenClawStateDatabaseForTest();
    expect(new WorkInputRepository({ path: dbPath }).get(created.request.id)).toEqual(resolved);
    expect(fs.readFileSync(dbPath).includes(Buffer.from("sentinel-secret-value"))).toBe(false);
  });

  it("expires pending requests without storing a response", () => {
    const dbPath = path.join(makeTempDir(dirs, "work-input-expiry-"), "state.sqlite");
    const repository = new WorkInputRepository({ path: dbPath, now: () => 200 });
    const created = repository.create({
      kind: "question",
      sessionKey: "agent:main:main",
      prompt: "Continue?",
      creator: { type: "system", label: "TaskFlow" },
      options: [{ id: "yes", label: "Yes" }],
      allowMultiple: false,
      allowFreeText: false,
      expiresAt: 100,
    });
    expect(repository.get(created.request.id)).toMatchObject({
      request: { status: "expired", revision: 2 },
      deliveryStatus: "not_applicable",
    });
  });

  it("rejects empty operator responses", () => {
    const dbPath = path.join(makeTempDir(dirs, "work-input-empty-"), "state.sqlite");
    const repository = new WorkInputRepository({ path: dbPath, now: () => 100 });
    const request = repository.create({
      kind: "add_information",
      sessionKey: "agent:main:main",
      prompt: "Provide information",
      creator: { type: "system", label: "TaskFlow" },
      allowedFields: ["text", "fileRefs"],
    });
    expect(() =>
      repository.resolve({
        requestId: request.request.id,
        expectedRevision: 1,
        idempotencyKey: "empty",
        actorId: "device:test",
        response: { text: "   " },
      }),
    ).toThrow(/invalid work input response/);
    expect(repository.get(request.request.id).request.status).toBe("pending");
  });

  it("paginates with a stable persisted sequence cursor", () => {
    const dbPath = path.join(makeTempDir(dirs, "work-input-pagination-"), "state.sqlite");
    const repository = new WorkInputRepository({ path: dbPath, now: () => 100 });
    for (const prompt of ["First", "Second", "Third"]) {
      repository.create({
        kind: "question",
        sessionKey: "agent:main:main",
        prompt,
        creator: { type: "system", label: "TaskFlow" },
        options: [{ id: "yes", label: "Yes" }],
        allowMultiple: false,
        allowFreeText: false,
      });
    }

    const first = repository.listPage({ sessionKey: "agent:main:main", limit: 2 });
    expect(first.records.map((record) => record.request.prompt)).toEqual(["Third", "Second"]);
    expect(first.nextCursor).toBeTypeOf("number");
    const second = repository.listPage({
      sessionKey: "agent:main:main",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.records.map((record) => record.request.prompt)).toEqual(["First"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("selects older delivery failures before applying the reconciliation bound", () => {
    const dbPath = path.join(makeTempDir(dirs, "work-input-delivery-"), "state.sqlite");
    const repository = new WorkInputRepository({ path: dbPath, now: () => 100 });
    const oldest = repository.create({
      kind: "approval",
      sessionKey: "agent:main:main",
      prompt: "Oldest pending delivery",
      creator: { type: "system", label: "TaskFlow" },
      flow: { flowId: "flow-oldest", expectedRevision: 1 },
    });
    repository.resolve({
      requestId: oldest.request.id,
      expectedRevision: 1,
      idempotencyKey: "resolve-oldest",
      actorId: "device:test",
      response: { choiceIds: ["approve"] },
    });
    for (let index = 0; index < 101; index += 1) {
      repository.create({
        kind: "question",
        sessionKey: "agent:main:main",
        prompt: `Newer request ${index}`,
        creator: { type: "system", label: "TaskFlow" },
        options: [{ id: "yes", label: "Yes" }],
        allowMultiple: false,
        allowFreeText: false,
      });
    }

    expect(repository.deliveryCandidates().map((entry) => entry.request.id)).toEqual([
      oldest.request.id,
    ]);
  });
});
