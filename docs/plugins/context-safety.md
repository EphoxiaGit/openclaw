---
summary: "Source-owned context-safety hooks and redaction-safe correlated telemetry"
read_when:
  - You are configuring the bundled context-safety plugin
  - You are integrating context-safety telemetry
---

# Context safety plugin

`@openclaw/context-safety` is a bundled, startup-activated safety plugin. It preserves the validated Phase 1a boundaries for tool arguments, individual and aggregate persisted tool results, broad search output, session-trajectory recursion, and provider preflight context.

## Hooks

The plugin registers five existing hooks:

- `before_tool_call`: blocks oversized or recursive arguments.
- `after_tool_call`: observes the result size without changing it.
- `tool_result_persist`: replaces unsafe persisted output with a bounded stub. Oversized content is written to a local artifact when possible; a failed artifact write still fails closed to the stub.
- `before_agent_run`: blocks at the hard context ratio and records warning decisions below it.
- `agent_end`: clears the in-memory aggregate budget for the authoritative run.

Aggregate accounting and telemetry require a host-provided `runId`. The plugin never derives correlation from session, agent, provider, model, tool-call, or private identifiers.

## Telemetry

When authoritative run correlation exists, the plugin emits the plugin-owned stream `context-safety.telemetry.v1` through `api.agent.events.emitAgentEvent`.

Payloads are bounded and contain only protocol/version, hook, outcome and reason enums, byte/token estimates, bounded aggregate/budget/ratio values, and `artifactPresent`. They never contain prompts, messages, arguments, results, errors, paths, artifact identifiers, request hashes, or session/provider/model/private identifiers. Telemetry failures are observational and do not crash ordinary traffic or weaken a block/stub decision.

## Configuration

Defaults preserve the Phase 1a thresholds. `artifactsDir` defaults to the state-relative `plugins/context-safety/artifacts`; no installed absolute path is embedded in source. Relative artifact paths are resolved only from the OpenClaw state directory and paths that escape that directory are rejected, keeping raw blocked output outside ordinary workspaces and repositories. Runtime validation additionally enforces:

- warning result bytes are below the hard result limit;
- search bytes do not exceed the hard result limit;
- aggregate budget is at least the hard result limit;
- preflight warning ratio is below the hard ratio.

Artifact directories are restricted to mode `0700` and files to `0600` where the platform supports POSIX modes. Generated artifacts, state, JSONL, checkpoints, backups, and installed runtime copies are not part of the package boundary.
