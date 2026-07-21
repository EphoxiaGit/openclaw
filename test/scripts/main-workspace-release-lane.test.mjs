import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildDryRunPlan,
  createReceipt,
  parseArgs,
  readReceipt,
  validateReceipt,
  writeReceipt,
} from "../../scripts/main-workspace-release-lane.mjs";

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CANDIDATE_REF =
  "oci://registry.example/openclaw@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LKG_REF =
  "oci://registry.example/openclaw@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONFIG_BACKUP_REF =
  "backup://archive.example/configuration@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const STATE_BACKUP_REF =
  "backup://archive.example/runtime-state@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const CANARY_CONFIG_REF =
  "artifact://canary.example/configuration@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CANARY_STATE_REF =
  "artifact://canary.example/runtime-state@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryReceiptPath() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-lane-"));
  temporaryDirectories.push(directory);
  return join(directory, "receipt.json");
}

function validInput() {
  return {
    sourceCommit: SOURCE_COMMIT,
    candidateReference: CANDIDATE_REF,
    lastKnownGoodReference: LKG_REF,
    configurationBackupReference: CONFIG_BACKUP_REF,
    runtimeStateBackupReference: STATE_BACKUP_REF,
    canaryConfigurationReference: CANARY_CONFIG_REF,
    canaryRuntimeStateReference: CANARY_STATE_REF,
  };
}

describe("main workspace release receipt", () => {
  it("creates a canonical mode-0600 receipt with literal fixed commands", () => {
    const path = temporaryReceiptPath();
    const receipt = createReceipt(validInput());

    writeReceipt(path, receipt);

    assert.deepEqual(readReceipt(path), receipt);
    assert.deepEqual(receipt.canaryReferences, {
      configuration: CANARY_CONFIG_REF,
      runtimeState: CANARY_STATE_REF,
    });
    assert.deepEqual(receipt.commands, {
      health: "openclaw gateway status --deep --require-rpc",
      activate: "openclaw config validate && openclaw gateway restart",
      rollback: "openclaw config validate && openclaw gateway restart",
    });
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(receipt, null, 2)}\n`);
  });

  it("emits the exact deterministic redacted plan without deployment authority", () => {
    const plan = buildDryRunPlan(createReceipt(validInput()));

    assert.deepEqual(plan, {
      schemaVersion: 1,
      dryRun: true,
      sourceCommit: SOURCE_COMMIT,
      candidateReference: "oci://[redacted:1c878620a605]",
      lastKnownGoodReference: "oci://[redacted:d129af225ee9]",
      externalBackupReferences: {
        configuration: "backup://[redacted:42821aac1b0b]",
        runtimeState: "backup://[redacted:31de2980f8f7]",
      },
      canaryReferences: {
        configuration: "artifact://[redacted:02bda55ef96e]",
        runtimeState: "artifact://[redacted:15a85a9b2126]",
      },
      capabilityProfiles: [
        {
          name: "builder",
          purpose: "Build and package the pinned source commit in a clean room.",
          commands: [
            "corepack pnpm install --frozen-lockfile",
            "NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 pnpm build",
            "pnpm ui:build",
            "pnpm pack --dry-run",
          ],
          activationAuthority: false,
        },
        {
          name: "canary",
          purpose: "Validate the candidate with isolated external config and state.",
          networkBoundary: "loopback-only",
          commands: [
            "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw config validate",
            "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway --bind loopback --port <isolated-port>",
            "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway health --port <isolated-port>",
          ],
          activationAuthority: false,
        },
        {
          name: "activator",
          purpose: "Explicitly select the candidate outside this tool, then restart and verify.",
          requiresExplicitActivation: true,
          command: "openclaw config validate && openclaw gateway restart",
          healthCommand: "openclaw gateway status --deep --require-rpc",
        },
        {
          name: "rollback",
          purpose:
            "Restore the last-known-good artifact and backups from outside the candidate lane.",
          executionBoundary: "outside-candidate-lane",
          command: "openclaw config validate && openclaw gateway restart",
          healthCommand: "openclaw gateway status --deep --require-rpc",
        },
      ],
    });
    assert.deepEqual(buildDryRunPlan(createReceipt(validInput())), plan);

    const output = JSON.stringify(plan);
    for (const reference of [
      CANDIDATE_REF,
      LKG_REF,
      CONFIG_BACKUP_REF,
      STATE_BACKUP_REF,
      CANARY_CONFIG_REF,
      CANARY_STATE_REF,
    ]) {
      assert.equal(output.includes(reference), false);
    }
  });

  it("rejects missing, duplicate, unsafe, and mutable command-line fields", () => {
    assert.throws(
      () => parseArgs(["create", "--receipt", "receipt.json"]),
      /--source-commit is required/u,
    );
    assert.throws(
      () =>
        parseArgs([
          "create",
          "--receipt",
          "receipt.json",
          "--source-commit",
          SOURCE_COMMIT,
          "--candidate-ref",
          CANDIDATE_REF,
          "--lkg-ref",
          LKG_REF,
          "--config-backup-ref",
          CONFIG_BACKUP_REF,
          "--state-backup-ref",
          STATE_BACKUP_REF,
          "--canary-config-ref",
          CANARY_CONFIG_REF,
        ]),
      /--canary-state-ref is required/u,
    );
    assert.throws(
      () => parseArgs(["validate", "--receipt", "receipt.json", "--receipt", "other.json"]),
      /provided more than once/u,
    );
    assert.throws(
      () =>
        createReceipt({ ...validInput(), candidateReference: "oci://registry.example/a;restart" }),
      /safe external reference/u,
    );
    assert.throws(
      () => createReceipt({ ...validInput(), candidateReference: "oci://registry.example/latest" }),
      /must end with @sha256/u,
    );
    assert.throws(
      () =>
        createReceipt({
          ...validInput(),
          candidateReference: `oci://registry.example/openclaw@sha256:${"A".repeat(64)}`,
        }),
      /64 lowercase hex/u,
    );
  });

  it("rejects schema, candidate/LKG, backup/canary, and command mutations", () => {
    const receipt = createReceipt(validInput());
    assert.throws(
      () => validateReceipt({ ...receipt, schemaVersion: 2 }),
      /schemaVersion must be 1/u,
    );
    assert.throws(
      () => createReceipt({ ...validInput(), lastKnownGoodReference: CANDIDATE_REF }),
      /scheme and authority normalization/u,
    );
    assert.throws(
      () =>
        createReceipt({
          ...validInput(),
          lastKnownGoodReference: CANDIDATE_REF.replace("oci://registry", "OCI://REGISTRY"),
        }),
      /scheme and authority normalization/u,
    );
    assert.throws(
      () =>
        createReceipt({
          ...validInput(),
          runtimeStateBackupReference: CONFIG_BACKUP_REF.replace(
            "backup://archive",
            "BACKUP://ARCHIVE",
          ),
        }),
      /external backup and canary references/u,
    );
    assert.throws(
      () => createReceipt({ ...validInput(), canaryRuntimeStateReference: CANARY_CONFIG_REF }),
      /external backup and canary references/u,
    );
    assert.throws(
      () =>
        validateReceipt({
          ...receipt,
          commands: { ...receipt.commands, health: "openclaw health" },
        }),
      /fixed health command/u,
    );
  });

  it("rejects non-canonical or duplicate receipt fields", () => {
    const path = temporaryReceiptPath();
    const receipt = createReceipt(validInput());
    const canonical = JSON.stringify(receipt, null, 2);
    const duplicate = canonical.replace(
      '  "sourceCommit":',
      `  "sourceCommit": "${SOURCE_COMMIT}",\n  "sourceCommit":`,
    );
    writeFileSync(path, `${duplicate}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);

    assert.throws(() => readReceipt(path), /duplicate, reordered, or non-canonical fields/u);
  });

  it("rejects receipts that are not mode 0600", () => {
    const path = temporaryReceiptPath();
    const receipt = createReceipt(validInput());
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    chmodSync(path, 0o644);

    assert.throws(() => readReceipt(path), /receipt mode must be 0600/u);
  });

  it("does not overwrite an existing receipt", () => {
    const path = temporaryReceiptPath();
    const receipt = createReceipt(validInput());
    writeReceipt(path, receipt);

    assert.throws(() => writeReceipt(path, receipt), /EEXIST/u);
  });
});
