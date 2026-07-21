---
summary: "External candidate and last-known-good receipts for source-built OpenClaw releases"
title: "Main workspace release lane"
read_when:
  - Building an OpenClaw candidate from a pinned source commit
  - Planning an external canary, activation, or rollback
---

The main workspace release lane records the inputs for an externally operated
candidate and last-known-good workflow. It does not deploy, restart, or connect
to OpenClaw. The source-owned tool only creates or validates a receipt and
prints a redacted dry-run plan.

## Capability profiles

Keep the four profiles separate. Give each operator or automation identity only
the capability its stage needs.

| Profile   | Capability                                                                | Must not do                                                      |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Builder   | Read the pinned source commit and publish an immutable candidate artifact | Read live config/state or activate a candidate                   |
| Canary    | Read the candidate plus isolated test config/state and bind to loopback   | Bind to LAN/tailnet or change the active installation            |
| Activator | Explicitly select the approved candidate, validate config, and restart    | Build artifacts or silently activate from a health-check process |
| Rollback  | Restore the recorded last-known-good artifact and external backups        | Depend on the candidate process, workspace, or credentials       |

Rollback control must remain outside the candidate lane. A broken candidate
must not be able to remove or prevent access to the last-known-good artifact,
configuration backup, runtime-state backup, receipt, or rollback identity.

## Create a receipt

Use immutable external references. Supported candidate and last-known-good
schemes are `artifact://` and `oci://`; backup schemes are `artifact://` and
`backup://`. Canary config and state use `artifact://` or `backup://`. Every
reference must end in `@sha256:` followed by a 64-character lowercase digest.
References cannot contain credentials, query strings, shell syntax, or relative
path segments. Scheme and authority casing does not make two otherwise equal
references distinct.

```bash
node scripts/main-workspace-release-lane.mjs create \
  --receipt <receipt-file> \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --candidate-ref oci://registry.example/openclaw@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --lkg-ref oci://registry.example/openclaw@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --config-backup-ref backup://archive.example/configuration@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  --state-backup-ref backup://archive.example/runtime-state@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
  --canary-config-ref artifact://canary.example/configuration@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee \
  --canary-state-ref artifact://canary.example/runtime-state@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

Creation is exclusive and does not overwrite an existing receipt. The tool
creates the file with mode `0600`, verifies that the filesystem preserves that
mode, and fails closed otherwise. Store the receipt outside the candidate
workspace so rollback does not depend on candidate availability.

Validate an existing receipt or reprint its redacted plan:

```bash
node scripts/main-workspace-release-lane.mjs validate --receipt <receipt-file>
node scripts/main-workspace-release-lane.mjs plan --receipt <receipt-file>
```

Validation requires the exact canonical schema and ordering emitted by the
tool. Missing, duplicate, reordered, unknown, unsafe, or modified command
fields are rejected. The plan hashes and redacts every external reference; the
mode-`0600` receipt remains the full binding record.

## Clean-room build and validation

The builder plan reuses the repository's existing commands in this order:

```bash
corepack pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 pnpm build
pnpm ui:build
pnpm pack --dry-run
```

The build uses the repository-supported CI memory settings. `pnpm pack
--dry-run` invokes the package `prepack` lifecycle, so do not run `pnpm
prepack` separately; that would repeat the full build. `pnpm ui:build` remains
an explicit acceptance step before package validation.

Run those commands in a fresh checkout detached at the receipt's full source
commit. Do not copy dependency directories, build output, config, runtime state,
credentials, or ignored files from another workspace. Publish the resulting
artifact under the exact immutable candidate reference in the receipt.

The canary runner materializes the receipt's immutable canary config and state
references at isolated locations. `OPENCLAW_CONFIG_PATH` and
`OPENCLAW_STATE_DIR` are OpenClaw's supported selectors for those locations.
Every canary command sets both selectors explicitly. Start the candidate CLI in
the foreground on a dedicated loopback port only:

```bash
OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw config validate
OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway --bind loopback --port <isolated-port>
OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway health --port <isolated-port>
```

Canary success is evidence, not activation. It must not mutate the active
installation or restart the active Gateway.

## Explicit activation and rollback

Activation is a separate, explicit operator action. The external activator
first selects the receipt's candidate artifact using its platform-owned install
mechanism, then runs the fixed activation command:

```bash
openclaw config validate && openclaw gateway restart
```

Verify the active service with the fixed health command:

```bash
openclaw gateway status --deep --require-rpc
```

If validation or health fails, the independent rollback profile restores the
receipt's last-known-good artifact and required external backups before running
the fixed rollback command:

```bash
openclaw config validate && openclaw gateway restart
```

Run the fixed health command again after rollback. The receipt deliberately
does not prescribe a host package manager, image scheduler, backup provider, or
service supervisor beyond OpenClaw's canonical config and Gateway lifecycle
commands; those external mechanisms remain owned by the deployment platform.
