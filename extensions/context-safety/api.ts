import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const CONTEXT_SAFETY_TELEMETRY_PROTOCOL = "context-safety.telemetry.v1" as const;
const MAX_EXCERPT_BYTES = 2048;
const SEARCH_TOOLS = new Set([
  "web_search",
  "filesystem__search_files",
  "search_files",
  "grep",
  "find",
]);

export type ContextSafetyConfig = {
  toolResultMaxBytes: number;
  toolResultWarnBytes: number;
  turnBudgetMaxBytes: number;
  toolArgMaxBytes: number;
  searchOutputMaxBytes: number;
  preflightWarnPct: number;
  preflightHardPct: number;
  contextWindowTokens: number;
  artifactsDir: string;
};

export const DEFAULT_CONTEXT_SAFETY_CONFIG: ContextSafetyConfig = {
  toolResultMaxBytes: 131_072,
  toolResultWarnBytes: 65_536,
  turnBudgetMaxBytes: 262_144,
  toolArgMaxBytes: 65_536,
  searchOutputMaxBytes: 10_240,
  preflightWarnPct: 0.6,
  preflightHardPct: 0.85,
  contextWindowTokens: 1_048_576,
  artifactsDir: "plugins/context-safety/artifacts",
};

type TelemetryHook =
  | "after_tool_call"
  | "tool_result_persist"
  | "before_tool_call"
  | "before_agent_run"
  | "agent_end";
type TelemetryOutcome = "observe" | "persist" | "warn" | "stub" | "block" | "reset";
type TelemetryReason =
  | "none"
  | "single_result_limit"
  | "single_result_warning"
  | "session_trajectory_recursion"
  | "broad_search_limit"
  | "aggregate_turn_limit"
  | "tool_argument_limit"
  | "warning_context_threshold"
  | "hard_context_threshold"
  | "turn_complete";

type Telemetry = {
  protocol: typeof CONTEXT_SAFETY_TELEMETRY_PROTOCOL;
  version: 1;
  hook: TelemetryHook;
  outcome: TelemetryOutcome;
  reason: TelemetryReason;
  byteEstimate: number;
  tokenEstimate: number;
  aggregateBytes?: number;
  budgetBytes?: number;
  budgetTokens?: number;
  ratio?: number;
  artifactPresent: boolean;
};

type TurnBudget = {
  observedBytes: number;
  persistedBytes: number;
  resultCount: number;
  artifactsDir?: string;
};

type ContextSafetyMessage = Extract<AgentMessage, { role: "toolResult" }>;

function finitePositiveInteger(value: unknown, name: string, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function finiteRatio(value: unknown, name: string, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0 || resolved > 1) {
    throw new Error(`${name} must be greater than 0 and at most 1`);
  }
  return resolved;
}

export function resolveContextSafetyConfig(
  value: unknown,
  resolvePath: (value: string) => string = (input) => input,
): ContextSafetyConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const config: ContextSafetyConfig = {
    toolResultMaxBytes: finitePositiveInteger(
      raw.toolResultMaxBytes,
      "toolResultMaxBytes",
      DEFAULT_CONTEXT_SAFETY_CONFIG.toolResultMaxBytes,
    ),
    toolResultWarnBytes: finitePositiveInteger(
      raw.toolResultWarnBytes,
      "toolResultWarnBytes",
      DEFAULT_CONTEXT_SAFETY_CONFIG.toolResultWarnBytes,
    ),
    turnBudgetMaxBytes: finitePositiveInteger(
      raw.turnBudgetMaxBytes,
      "turnBudgetMaxBytes",
      DEFAULT_CONTEXT_SAFETY_CONFIG.turnBudgetMaxBytes,
    ),
    toolArgMaxBytes: finitePositiveInteger(
      raw.toolArgMaxBytes,
      "toolArgMaxBytes",
      DEFAULT_CONTEXT_SAFETY_CONFIG.toolArgMaxBytes,
    ),
    searchOutputMaxBytes: finitePositiveInteger(
      raw.searchOutputMaxBytes,
      "searchOutputMaxBytes",
      DEFAULT_CONTEXT_SAFETY_CONFIG.searchOutputMaxBytes,
    ),
    preflightWarnPct: finiteRatio(
      raw.preflightWarnPct,
      "preflightWarnPct",
      DEFAULT_CONTEXT_SAFETY_CONFIG.preflightWarnPct,
    ),
    preflightHardPct: finiteRatio(
      raw.preflightHardPct,
      "preflightHardPct",
      DEFAULT_CONTEXT_SAFETY_CONFIG.preflightHardPct,
    ),
    contextWindowTokens: finitePositiveInteger(
      raw.contextWindowTokens,
      "contextWindowTokens",
      DEFAULT_CONTEXT_SAFETY_CONFIG.contextWindowTokens,
    ),
    artifactsDir: (() => {
      const configured =
        typeof raw.artifactsDir === "string" && raw.artifactsDir.trim()
          ? raw.artifactsDir.trim()
          : DEFAULT_CONTEXT_SAFETY_CONFIG.artifactsDir;
      return isAbsolute(configured) || configured.startsWith("~")
        ? resolvePath(configured)
        : configured;
    })(),
  };
  if (config.toolResultWarnBytes >= config.toolResultMaxBytes) {
    throw new Error("toolResultWarnBytes must be less than toolResultMaxBytes");
  }
  if (config.searchOutputMaxBytes > config.toolResultMaxBytes) {
    throw new Error("searchOutputMaxBytes must not exceed toolResultMaxBytes");
  }
  if (config.turnBudgetMaxBytes < config.toolResultMaxBytes) {
    throw new Error("turnBudgetMaxBytes must be at least toolResultMaxBytes");
  }
  if (config.preflightWarnPct >= config.preflightHardPct) {
    throw new Error("preflightWarnPct must be less than preflightHardPct");
  }
  return config;
}

function resolveArtifactsDir(params: {
  configured: string;
  stateDir: string;
  resolvePath: (value: string) => string;
}): string | undefined {
  if (isAbsolute(params.configured) || params.configured.startsWith("~")) {
    return params.resolvePath(params.configured);
  }
  let stateDir: string;
  try {
    stateDir = realpathSync(params.stateDir);
  } catch {
    return undefined;
  }
  const candidate = resolve(stateDir, params.configured);
  const fromStateDir = relative(stateDir, candidate);
  if (fromStateDir !== "" && (fromStateDir.startsWith(`..${sep}`) || fromStateDir === "..")) {
    return undefined;
  }
  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      return undefined;
    }
    existingAncestor = parent;
  }
  try {
    const realAncestor = realpathSync(existingAncestor);
    const realFromStateDir = relative(stateDir, realAncestor);
    return realFromStateDir === "" ||
      (!realFromStateDir.startsWith(`..${sep}`) && realFromStateDir !== "..")
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function utf8Excerpt(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] ?? "")) {
    low -= 1;
  }
  return value.slice(0, low);
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 3.5);
}

function contentText(message: ContextSafetyMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return stringify(message.content ?? "");
  }
  return message.content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return stringify(block);
    })
    .join("\n");
}

function contentBytes(message: ContextSafetyMessage): number {
  return utf8Bytes(stringify(message.content ?? ""));
}

function resultBytes(result: unknown): number {
  if (result && typeof result === "object" && "content" in result) {
    return utf8Bytes(stringify((result as { content?: unknown }).content));
  }
  return utf8Bytes(stringify(result ?? ""));
}

function hasSessionRecursion(text: string): boolean {
  if (!text) {
    return false;
  }
  const references = text.match(/[^\s"'<>()[\]{}]{1,512}\.jsonl/g) ?? [];
  return new Set(references).size > 3 || (text.includes("lcm.db") && new Set(references).size > 1);
}

function writeArtifact(dir: string, message: ContextSafetyMessage): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, `result-${Date.now()}-${randomUUID()}.json`);
    writeFileSync(path, `${JSON.stringify(message, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function replacementMessage(
  message: ContextSafetyMessage,
  params: { reason: TelemetryReason; bytes: number; excerpt?: string; artifactPresent: boolean },
): ContextSafetyMessage {
  const header = params.artifactPresent
    ? "[Context safety: output exceeded a safety boundary and was stored as a local artifact; only this bounded stub was persisted.]"
    : "[Context safety: output exceeded a safety boundary and was omitted because a safe local artifact could not be written.]";
  const text = params.excerpt ? `${header}\nExcerpt:\n${params.excerpt}` : header;
  return {
    ...message,
    content: [{ type: "text", text }],
    details: {
      contextSafety: {
        action: "stub",
        reason: params.reason,
        originalBytes: params.bytes,
        artifactPresent: params.artifactPresent,
        ...(params.excerpt ? { excerptBytes: utf8Bytes(params.excerpt) } : {}),
      },
    },
  };
}

function telemetry(
  api: OpenClawPluginApi,
  runId: string | undefined,
  data: Omit<Telemetry, "protocol" | "version">,
): void {
  if (!runId) {
    return;
  }
  const payload: Telemetry = { protocol: CONTEXT_SAFETY_TELEMETRY_PROTOCOL, version: 1, ...data };
  try {
    api.agent.events.emitAgentEvent({
      runId,
      stream: CONTEXT_SAFETY_TELEMETRY_PROTOCOL,
      data: payload,
    });
  } catch {
    // Observation must never break ordinary traffic or weaken an already-made block/stub decision.
  }
}

export function registerContextSafety(api: OpenClawPluginApi): void {
  const config = resolveContextSafetyConfig(api.pluginConfig, api.resolvePath);
  const stateDir = api.runtime.state.resolveStateDir();
  const turns = new Map<string, TurnBudget>();
  const turnFor = (runId: string | undefined): TurnBudget | undefined => {
    if (!runId) {
      return undefined;
    }
    const existing = turns.get(runId);
    if (existing) {
      return existing;
    }
    const created = { observedBytes: 0, persistedBytes: 0, resultCount: 0 };
    turns.set(runId, created);
    return created;
  };

  api.on("after_tool_call", (event, ctx) => {
    const bytes = resultBytes(event.result);
    telemetry(api, event.runId ?? ctx.runId, {
      hook: "after_tool_call",
      outcome: "observe",
      reason: "none",
      byteEstimate: bytes,
      tokenEstimate: estimateTokens(bytes),
      artifactPresent: false,
    });
  });

  api.on("tool_result_persist", (event, ctx) => {
    if (event.message.role !== "toolResult") {
      return undefined;
    }
    const message = event.message;
    const bytes = contentBytes(message);
    const text = contentText(message);
    const runId = ctx.runId;
    const turn = turnFor(runId);
    const projected = (turn?.persistedBytes ?? 0) + bytes;
    const tool =
      typeof event.toolName === "string"
        ? event.toolName
        : typeof message.toolName === "string"
          ? message.toolName
          : "";
    let outcome: TelemetryOutcome = "persist";
    let reason: TelemetryReason = "none";
    if (bytes > config.toolResultMaxBytes) {
      reason = "single_result_limit";
    } else if (bytes > 1000 && hasSessionRecursion(text)) {
      reason = "session_trajectory_recursion";
    } else if (SEARCH_TOOLS.has(tool) && bytes > config.searchOutputMaxBytes) {
      reason = "broad_search_limit";
    } else if (turn && projected > config.turnBudgetMaxBytes) {
      reason = "aggregate_turn_limit";
    } else if (bytes > config.toolResultWarnBytes) {
      outcome = "warn";
      reason = "single_result_warning";
    }

    let persisted = message;
    let artifactPresent = false;
    if (
      [
        "single_result_limit",
        "session_trajectory_recursion",
        "broad_search_limit",
        "aggregate_turn_limit",
      ].includes(reason)
    ) {
      outcome = "stub";
      const artifactsDir =
        turn?.artifactsDir ??
        resolveArtifactsDir({
          configured: config.artifactsDir,
          stateDir,
          resolvePath: api.resolvePath,
        });
      artifactPresent = artifactsDir ? writeArtifact(artifactsDir, message) : false;
      persisted = replacementMessage(message, {
        reason,
        bytes,
        artifactPresent,
        ...(reason === "broad_search_limit"
          ? { excerpt: utf8Excerpt(text, MAX_EXCERPT_BYTES) }
          : {}),
      });
    }
    const persistedBytes = contentBytes(persisted);
    if (turn) {
      turn.resultCount += 1;
      turn.observedBytes += bytes;
      turn.persistedBytes += persistedBytes;
    }
    telemetry(api, runId, {
      hook: "tool_result_persist",
      outcome,
      reason,
      byteEstimate: bytes,
      tokenEstimate: estimateTokens(bytes),
      ...(turn
        ? {
            aggregateBytes: Math.min(turn.persistedBytes, config.turnBudgetMaxBytes),
            budgetBytes: config.turnBudgetMaxBytes,
            ratio: Math.min(1, turn.persistedBytes / config.turnBudgetMaxBytes),
          }
        : {}),
      artifactPresent,
    });
    return persisted === message ? undefined : { message: persisted };
  });

  api.on("before_tool_call", (event, ctx) => {
    const text = stringify(event.params ?? {});
    const bytes = utf8Bytes(text);
    const reason: TelemetryReason =
      bytes > config.toolArgMaxBytes
        ? "tool_argument_limit"
        : bytes > 500 && hasSessionRecursion(text)
          ? "session_trajectory_recursion"
          : "none";
    const blocked = reason !== "none";
    telemetry(api, event.runId ?? ctx.runId, {
      hook: "before_tool_call",
      outcome: blocked ? "block" : "persist",
      reason,
      byteEstimate: bytes,
      tokenEstimate: estimateTokens(bytes),
      artifactPresent: false,
    });
    return blocked
      ? { block: true, blockReason: "Tool arguments exceeded a context-safety boundary." }
      : {};
  });

  api.on("before_agent_run", (event, ctx) => {
    const turn = turnFor(ctx.runId);
    if (turn && !turn.artifactsDir) {
      turn.artifactsDir = resolveArtifactsDir({
        configured: config.artifactsDir,
        stateDir,
        resolvePath: api.resolvePath,
      });
    }
    const bytes =
      utf8Bytes(event.prompt ?? "") +
      utf8Bytes(event.systemPrompt ?? "") +
      utf8Bytes(stringify(event.messages ?? []));
    const tokens = estimateTokens(bytes);
    const runtimeContextWindowTokens =
      typeof ctx.contextTokenBudget === "number" &&
      Number.isFinite(ctx.contextTokenBudget) &&
      ctx.contextTokenBudget > 0
        ? Math.floor(ctx.contextTokenBudget)
        : undefined;
    const contextWindowTokens = runtimeContextWindowTokens ?? config.contextWindowTokens;
    const ratio = tokens / contextWindowTokens;
    const blocked = ratio >= config.preflightHardPct;
    const warned = !blocked && ratio >= config.preflightWarnPct;
    const reason: TelemetryReason = blocked
      ? "hard_context_threshold"
      : warned
        ? "warning_context_threshold"
        : "none";
    telemetry(api, ctx.runId, {
      hook: "before_agent_run",
      outcome: blocked ? "block" : warned ? "warn" : "persist",
      reason,
      byteEstimate: bytes,
      tokenEstimate: tokens,
      budgetTokens: contextWindowTokens,
      ratio: Math.min(1, ratio),
      artifactPresent: false,
    });
    return blocked
      ? {
          outcome: "block",
          reason: "context_overflow_preflight",
          category: "context_safety",
          message:
            "Context preflight reached the configured hard boundary. Compact or rotate before continuing.",
        }
      : { outcome: "pass" };
  });

  api.on("agent_end", (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    if (!runId) {
      return;
    }
    const turn = turns.get(runId);
    turns.delete(runId);
    const bytes = turn?.observedBytes ?? 0;
    telemetry(api, runId, {
      hook: "agent_end",
      outcome: "reset",
      reason: "turn_complete",
      byteEstimate: bytes,
      tokenEstimate: estimateTokens(bytes),
      ...(turn
        ? {
            aggregateBytes: Math.min(turn.persistedBytes, config.turnBudgetMaxBytes),
            budgetBytes: config.turnBudgetMaxBytes,
            ratio: Math.min(1, turn.persistedBytes / config.turnBudgetMaxBytes),
          }
        : {}),
      artifactPresent: false,
    });
  });
}
