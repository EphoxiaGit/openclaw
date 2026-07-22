import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_SAFETY_TELEMETRY_PROTOCOL,
  registerContextSafety,
  resolveContextSafetyConfig,
  utf8Bytes,
  utf8Excerpt,
} from "./api.js";
import plugin from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

type Handler = (event: any, ctx: any) => any;
function harness(config: Record<string, unknown> = {}, emit = vi.fn()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-safety-source-"));
  roots.push(root);
  const handlers: Record<string, Handler> = {};
  const artifactsDir = path.join(root, "artifacts");
  const api = {
    pluginConfig: { artifactsDir, ...config },
    resolvePath: (input: string) => (path.isAbsolute(input) ? input : path.join(root, input)),
    runtime: { state: { resolveStateDir: () => root } },
    on: (name: string, handler: Handler) => {
      handlers[name] = handler;
    },
    agent: { events: { emitAgentEvent: emit } },
  } as unknown as OpenClawPluginApi;
  registerContextSafety(api);
  return { root, artifactsDir, handlers, emit };
}

function context(runId = "synthetic-run") {
  return { runId, sessionId: "synthetic-session", provider: "synthetic", model: "synthetic" };
}

function message(text: string, toolName = "read") {
  return {
    role: "toolResult",
    toolName,
    toolCallId: "synthetic-call",
    content: [{ type: "text", text }],
    details: { synthetic: true },
    isError: false,
  };
}

function persistedText(result: any): string {
  return result.message.content.map((block: any) => block.text ?? "").join("\n");
}

describe("context-safety Phase 1a", () => {
  it("exports the bundled source entry and five hooks", () => {
    expect(plugin.id).toBe("context-safety");
    const { handlers } = harness();
    expect(Object.keys(handlers).toSorted()).toEqual([
      "after_tool_call",
      "agent_end",
      "before_agent_run",
      "before_tool_call",
      "tool_result_persist",
    ]);
  });

  it("stubs an oversized result and writes a private artifact", () => {
    const { handlers, artifactsDir } = harness();
    const original = "O".repeat(150 * 1024);
    const result = handlers.tool_result_persist(
      { toolName: "exec", message: message(original, "exec") },
      context("oversized"),
    );
    expect(utf8Bytes(persistedText(result))).toBeLessThan(1024);
    const files = fs.readdirSync(artifactsDir);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(fs.readFileSync(path.join(artifactsDir, files[0]), "utf8"));
    expect(stored.content[0].text).toBe(original);
    expect(fs.statSync(artifactsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(artifactsDir, files[0])).mode & 0o777).toBe(0o600);
  });

  it("enforces the aggregate budget only with authoritative run correlation", () => {
    const { handlers } = harness();
    const ctx = context("aggregate");
    expect(
      handlers.tool_result_persist(
        { toolName: "read", message: message("A".repeat(100 * 1024)) },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      handlers.tool_result_persist(
        { toolName: "read", message: message("B".repeat(100 * 1024)) },
        ctx,
      ),
    ).toBeUndefined();
    const third = handlers.tool_result_persist(
      { toolName: "read", message: message("C".repeat(70 * 1024)) },
      ctx,
    );
    expect(third.message.details.contextSafety.reason).toBe("aggregate_turn_limit");

    const missing = harness();
    for (let index = 0; index < 3; index += 1) {
      expect(
        missing.handlers.tool_result_persist(
          { toolName: "read", message: message("D".repeat(100 * 1024)) },
          {},
        ),
      ).toBeUndefined();
    }
    expect(missing.emit).not.toHaveBeenCalled();
  });

  it("blocks oversized and recursive tool arguments", () => {
    const { handlers } = harness();
    expect(
      handlers.before_tool_call(
        { toolName: "exec", params: { command: "X".repeat(70 * 1024) }, runId: "arg" },
        context("arg"),
      ).block,
    ).toBe(true);
    const recursion = `${"R".repeat(600)} a.jsonl b.jsonl c.jsonl d.jsonl lcm.db`;
    expect(
      handlers.before_tool_call(
        { toolName: "read", params: { input: recursion }, runId: "rec" },
        context("rec"),
      ).block,
    ).toBe(true);
  });

  it("bounds broad search with a UTF-8 safe excerpt", () => {
    const { handlers } = harness();
    const result = handlers.tool_result_persist(
      {
        toolName: "filesystem__search_files",
        message: message("🔎".repeat(4_000), "filesystem__search_files"),
      },
      context("search"),
    );
    expect(result.message.details.contextSafety.reason).toBe("broad_search_limit");
    expect(result.message.details.contextSafety.excerptBytes).toBeLessThanOrEqual(2048);
    expect(persistedText(result)).toContain("Excerpt:");
    const excerpt = utf8Excerpt("😀".repeat(100), 17);
    expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(17);
    expect(excerpt.endsWith("\ud83d")).toBe(false);
  });

  it("stubs session trajectory recursion", () => {
    const { handlers } = harness();
    const recursive = `${"R".repeat(1_200)} /tmp/a.jsonl /tmp/b.jsonl /tmp/c.jsonl /tmp/d.jsonl lcm.db`;
    const result = handlers.tool_result_persist(
      { toolName: "read", message: message(recursive) },
      context("recursion"),
    );
    expect(result.message.details.contextSafety.reason).toBe("session_trajectory_recursion");
  });

  it("passes warning preflight and blocks hard preflight", () => {
    const { handlers, emit } = harness();
    const warning = handlers.before_agent_run(
      {
        prompt: "",
        systemPrompt: "",
        messages: [{ role: "user", content: "W".repeat(2_250 * 1024) }],
      },
      context("warning"),
    );
    const hard = handlers.before_agent_run(
      {
        prompt: "",
        systemPrompt: "",
        messages: [{ role: "user", content: "H".repeat(3_200 * 1024) }],
      },
      context("hard"),
    );
    expect(warning.outcome).toBe("pass");
    expect(hard.outcome).toBe("block");
    expect(
      emit.mock.calls.some(([entry]) => entry.data.reason === "warning_context_threshold"),
    ).toBe(true);
    expect(emit.mock.calls.some(([entry]) => entry.data.reason === "hard_context_threshold")).toBe(
      true,
    );
  });

  it("uses the host-resolved context budget for preflight", () => {
    const { handlers, emit } = harness({ contextWindowTokens: 1_000_000 });
    const result = handlers.before_agent_run(
      { prompt: "H".repeat(400), systemPrompt: "", messages: [] },
      { ...context("runtime-budget"), contextTokenBudget: 100 },
    );

    expect(result.outcome).toBe("block");
    const entry = emit.mock.calls.find(
      ([candidate]) => candidate.data.reason === "hard_context_threshold",
    )?.[0];
    expect(entry?.data.budgetTokens).toBe(100);
  });

  it("does not double-count persisted results already represented by preflight messages", () => {
    const { handlers } = harness();
    const ctx = { ...context("no-double-count"), contextTokenBudget: 100 };
    handlers.tool_result_persist({ toolName: "read", message: message("P".repeat(400)) }, ctx);

    const result = handlers.before_agent_run({ prompt: "", systemPrompt: "", messages: [] }, ctx);
    expect(result.outcome).toBe("pass");
  });

  it("emits only bounded allowlisted telemetry and tolerates observation failures", () => {
    const canaries = [
      "PRIVATE_PROMPT_CANARY",
      "private/session/id",
      "/private/artifact/path",
      "provider-secret",
      "raw-error",
    ];
    const { handlers, emit } = harness();
    expect(() =>
      handlers.after_tool_call(
        { result: { content: canaries }, runId: "telemetry" },
        context("telemetry"),
      ),
    ).not.toThrow();
    handlers.before_tool_call(
      {
        toolName: "exec",
        params: { command: "X".repeat(70 * 1024), canaries },
        runId: "telemetry",
      },
      context("telemetry"),
    );
    const allowed = new Set([
      "protocol",
      "version",
      "hook",
      "outcome",
      "reason",
      "byteEstimate",
      "tokenEstimate",
      "aggregateBytes",
      "budgetBytes",
      "budgetTokens",
      "ratio",
      "artifactPresent",
    ]);
    for (const [{ stream, data }] of emit.mock.calls) {
      expect(stream).toBe(CONTEXT_SAFETY_TELEMETRY_PROTOCOL);
      expect(data.protocol).toBe(CONTEXT_SAFETY_TELEMETRY_PROTOCOL);
      expect(data.version).toBe(1);
      expect(Object.keys(data).every((key) => allowed.has(key))).toBe(true);
      const serialized = JSON.stringify(data);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4096);
      for (const canary of canaries) {
        expect(serialized).not.toContain(canary);
      }
    }

    const failing = harness(
      {},
      vi.fn(() => {
        throw new Error("synthetic telemetry failure");
      }),
    );
    expect(() =>
      failing.handlers.after_tool_call(
        { result: { content: "ok" }, runId: "fail" },
        context("fail"),
      ),
    ).not.toThrow();
    expect(
      failing.handlers.before_tool_call(
        { toolName: "exec", params: { command: "X".repeat(70 * 1024) }, runId: "fail" },
        context("fail"),
      ).block,
    ).toBe(true);
  });

  it("fails closed to a stub when artifact writing fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-safety-write-failure-"));
    roots.push(root);
    const blockedPath = path.join(root, "not-a-directory");
    fs.writeFileSync(blockedPath, "occupied", { mode: 0o600 });
    const { handlers } = harness({ artifactsDir: blockedPath });
    const result = handlers.tool_result_persist(
      { toolName: "exec", message: message("Z".repeat(150 * 1024)) },
      context("write-failure"),
    );
    expect(result.message.details.contextSafety.artifactPresent).toBe(false);
    expect(utf8Bytes(persistedText(result))).toBeLessThan(1024);
  });

  it("validates numeric and cross-field configuration", () => {
    expect(() => resolveContextSafetyConfig({ toolResultMaxBytes: 0 })).toThrow(/positive integer/);
    expect(() =>
      resolveContextSafetyConfig({ toolResultWarnBytes: 200, toolResultMaxBytes: 100 }),
    ).toThrow(/less than/);
    expect(() =>
      resolveContextSafetyConfig({ preflightWarnPct: 0.9, preflightHardPct: 0.8 }),
    ).toThrow(/less than/);
    expect(() =>
      resolveContextSafetyConfig({
        searchOutputMaxBytes: 25,
        toolResultWarnBytes: 50,
        turnBudgetMaxBytes: 100,
        toolResultMaxBytes: 200,
      }),
    ).toThrow(/at least/);
  });

  it("resolves the default artifact directory inside the host state directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-safety-state-"));
    roots.push(root);
    const handlers: Record<string, Handler> = {};
    const api = {
      pluginConfig: {},
      resolvePath: (input: string) => input,
      runtime: { state: { resolveStateDir: () => root } },
      on: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
      agent: { events: { emitAgentEvent: vi.fn() } },
    } as unknown as OpenClawPluginApi;
    registerContextSafety(api);
    handlers.before_agent_run(
      { prompt: "", systemPrompt: "", messages: [] },
      context("state-artifact"),
    );
    const result = handlers.tool_result_persist(
      { toolName: "exec", message: message("W".repeat(150 * 1024), "exec") },
      context("state-artifact"),
    );
    const artifactsDir = path.join(root, "plugins", "context-safety", "artifacts");
    expect(result.message.details.contextSafety.artifactPresent).toBe(true);
    expect(fs.readdirSync(artifactsDir)).toHaveLength(1);
  });

  it("rejects relative artifact paths that escape the host state directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-safety-state-escape-"));
    const outside = `${root}-outside`;
    roots.push(root);
    roots.push(outside);
    const { handlers } = harness({ artifactsDir: `../${path.basename(outside)}` });
    handlers.before_agent_run(
      { prompt: "", systemPrompt: "", messages: [] },
      context("state-escape"),
    );
    const result = handlers.tool_result_persist(
      { toolName: "exec", message: message("E".repeat(150 * 1024), "exec") },
      context("state-escape"),
    );
    expect(result.message.details.contextSafety.artifactPresent).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("rejects state-relative artifact paths that escape through symlinks", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-safety-symlink-outside-"));
    roots.push(outside);
    const { root, handlers } = harness({ artifactsDir: "artifact-link" });
    fs.symlinkSync(
      outside,
      path.join(root, "artifact-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    handlers.before_agent_run(
      { prompt: "", systemPrompt: "", messages: [] },
      context("state-symlink"),
    );

    const result = handlers.tool_result_persist(
      { toolName: "exec", message: message("S".repeat(150 * 1024), "exec") },
      context("state-symlink"),
    );
    expect(result.message.details.contextSafety.artifactPresent).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("keeps generated runtime data outside the package boundary", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.files).toEqual([
      "api.ts",
      "index.ts",
      "openclaw.plugin.json",
      "package.json",
    ]);
    const names = fs.readdirSync(new URL(".", import.meta.url));
    expect(names.some((name) => /state|artifact|jsonl|checkpoint|backup/i.test(name))).toBe(false);
  });
});
