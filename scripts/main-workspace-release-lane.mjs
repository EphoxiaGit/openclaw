#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

export const RECEIPT_SCHEMA_VERSION = 1;
export const HEALTH_COMMAND = "openclaw gateway status --deep --require-rpc";
export const ACTIVATION_COMMAND = "openclaw config validate && openclaw gateway restart";
export const ROLLBACK_COMMAND = "openclaw config validate && openclaw gateway restart";

export const BUILDER_COMMANDS = Object.freeze([
  "corepack pnpm install --frozen-lockfile",
  "NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 pnpm build",
  "pnpm ui:build",
  "pnpm pack --dry-run",
]);

const CANARY_COMMANDS = Object.freeze([
  "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw config validate",
  "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway --bind loopback --port <isolated-port>",
  "OPENCLAW_CONFIG_PATH=<isolated-config> OPENCLAW_STATE_DIR=<isolated-state> openclaw gateway health --port <isolated-port>",
]);
const RECEIPT_MODE = 0o600;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._~:/@+-]*$/u;
const IMMUTABLE_REFERENCE_SUFFIX_PATTERN = /@sha256:[a-f0-9]{64}$/u;
const EXPECTED_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "sourceCommit",
  "candidateReference",
  "lastKnownGoodReference",
  "externalBackupReferences",
  "canaryReferences",
  "commands",
];

function usage() {
  return `Usage:
  node scripts/main-workspace-release-lane.mjs create \\
    --receipt <path> \\
    --source-commit <full-sha> \\
    --candidate-ref <external-ref> \\
    --lkg-ref <external-ref> \\
    --config-backup-ref <external-ref> \\
    --state-backup-ref <external-ref> \\
    --canary-config-ref <external-ref> \\
    --canary-state-ref <external-ref>
  node scripts/main-workspace-release-lane.mjs validate --receipt <path>
  node scripts/main-workspace-release-lane.mjs plan --receipt <path>

This tool only writes or validates a release receipt and prints a redacted dry-run plan.
It never builds, activates, restarts, rolls back, or connects to a Gateway.
`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key, index) => actualKeys[index] !== key)
  ) {
    throw new Error(`${label} fields must be exactly: ${expectedKeys.join(", ")}`);
  }
}

function assertSafeReference(value, label, allowedSchemes) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (value.length > 512 || !REFERENCE_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a safe external reference without whitespace or shell syntax`,
    );
  }

  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  if (!allowedSchemes.has(scheme)) {
    throw new Error(`${label} must use one of: ${[...allowedSchemes].join(", ")}`);
  }

  const remainder = value.slice(value.indexOf("://") + 3);
  const authority = remainder.split("/", 1)[0];
  if (authority.includes("@")) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  if (remainder.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain relative path segments`);
  }
  if (!IMMUTABLE_REFERENCE_SUFFIX_PATTERN.test(value)) {
    throw new Error(`${label} must end with @sha256:<64 lowercase hex characters>`);
  }
}

function normalizeReferenceForComparison(reference) {
  const separator = reference.indexOf("://");
  const scheme = reference.slice(0, separator).toLowerCase();
  const remainder = reference.slice(separator + 3);
  const slash = remainder.indexOf("/");
  const authority = (slash === -1 ? remainder : remainder.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "" : remainder.slice(slash);
  return `${scheme}://${authority}${path}`;
}

function assertDistinctReferences(entries, label) {
  const normalized = new Set();
  for (const reference of entries) {
    const comparable = normalizeReferenceForComparison(reference);
    if (normalized.has(comparable)) {
      throw new Error(`${label} must be different after scheme and authority normalization`);
    }
    normalized.add(comparable);
  }
}

function canonicalReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function createReceipt(input) {
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    sourceCommit: input.sourceCommit,
    candidateReference: input.candidateReference,
    lastKnownGoodReference: input.lastKnownGoodReference,
    externalBackupReferences: {
      configuration: input.configurationBackupReference,
      runtimeState: input.runtimeStateBackupReference,
    },
    canaryReferences: {
      configuration: input.canaryConfigurationReference,
      runtimeState: input.canaryRuntimeStateReference,
    },
    commands: {
      health: HEALTH_COMMAND,
      activate: ACTIVATION_COMMAND,
      rollback: ROLLBACK_COMMAND,
    },
  };
  validateReceipt(receipt);
  return receipt;
}

export function validateReceipt(receipt) {
  assertPlainObject(receipt, "receipt");
  assertExactKeys(receipt, EXPECTED_TOP_LEVEL_KEYS, "receipt");
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${RECEIPT_SCHEMA_VERSION}`);
  }
  if (
    typeof receipt.sourceCommit !== "string" ||
    !SOURCE_COMMIT_PATTERN.test(receipt.sourceCommit)
  ) {
    throw new Error("sourceCommit must be a full lowercase 40-character Git commit SHA");
  }

  const artifactSchemes = new Set(["artifact", "oci"]);
  const backupSchemes = new Set(["artifact", "backup"]);
  assertSafeReference(receipt.candidateReference, "candidateReference", artifactSchemes);
  assertSafeReference(receipt.lastKnownGoodReference, "lastKnownGoodReference", artifactSchemes);
  assertDistinctReferences(
    [receipt.candidateReference, receipt.lastKnownGoodReference],
    "candidateReference and lastKnownGoodReference",
  );

  assertPlainObject(receipt.externalBackupReferences, "externalBackupReferences");
  assertExactKeys(
    receipt.externalBackupReferences,
    ["configuration", "runtimeState"],
    "externalBackupReferences",
  );
  assertSafeReference(
    receipt.externalBackupReferences.configuration,
    "externalBackupReferences.configuration",
    backupSchemes,
  );
  assertSafeReference(
    receipt.externalBackupReferences.runtimeState,
    "externalBackupReferences.runtimeState",
    backupSchemes,
  );
  assertPlainObject(receipt.canaryReferences, "canaryReferences");
  assertExactKeys(receipt.canaryReferences, ["configuration", "runtimeState"], "canaryReferences");
  assertSafeReference(
    receipt.canaryReferences.configuration,
    "canaryReferences.configuration",
    backupSchemes,
  );
  assertSafeReference(
    receipt.canaryReferences.runtimeState,
    "canaryReferences.runtimeState",
    backupSchemes,
  );
  assertDistinctReferences(
    [
      receipt.externalBackupReferences.configuration,
      receipt.externalBackupReferences.runtimeState,
      receipt.canaryReferences.configuration,
      receipt.canaryReferences.runtimeState,
    ],
    "external backup and canary references",
  );

  assertPlainObject(receipt.commands, "commands");
  assertExactKeys(receipt.commands, ["health", "activate", "rollback"], "commands");
  if (receipt.commands.health !== HEALTH_COMMAND) {
    throw new Error("commands.health does not match the fixed health command");
  }
  if (receipt.commands.activate !== ACTIVATION_COMMAND) {
    throw new Error("commands.activate does not match the fixed activation command");
  }
  if (receipt.commands.rollback !== ROLLBACK_COMMAND) {
    throw new Error("commands.rollback does not match the fixed rollback command");
  }
  return receipt;
}

function assertReceiptMode(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("receipt must be a regular file, not a symlink");
  }
  const mode = stats.mode & 0o777;
  if (mode !== RECEIPT_MODE) {
    throw new Error(`receipt mode must be 0600, found ${mode.toString(8).padStart(4, "0")}`);
  }
}

export function writeReceipt(path, receipt) {
  validateReceipt(receipt);
  let descriptor;
  try {
    descriptor = openSync(path, "wx", RECEIPT_MODE);
    fchmodSync(descriptor, RECEIPT_MODE);
    writeFileSync(descriptor, canonicalReceipt(receipt), "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original write or mode error.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  try {
    assertReceiptMode(path);
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
}

export function readReceipt(path) {
  assertReceiptMode(path);
  const stats = lstatSync(path);
  if (stats.size > MAX_RECEIPT_BYTES) {
    throw new Error(`receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  const source = readFileSync(path, "utf8");
  let receipt;
  try {
    receipt = JSON.parse(source);
  } catch (error) {
    throw new Error(`receipt is not valid JSON: ${error.message}`);
  }
  validateReceipt(receipt);
  if (source !== canonicalReceipt(receipt)) {
    throw new Error(
      "receipt is not in canonical form; duplicate, reordered, or non-canonical fields are rejected",
    );
  }
  return receipt;
}

function redactReference(reference) {
  const scheme = reference.slice(0, reference.indexOf(":")).toLowerCase();
  const digest = createHash("sha256").update(reference).digest("hex").slice(0, 12);
  return `${scheme}://[redacted:${digest}]`;
}

export function buildDryRunPlan(receipt) {
  validateReceipt(receipt);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    dryRun: true,
    sourceCommit: receipt.sourceCommit,
    candidateReference: redactReference(receipt.candidateReference),
    lastKnownGoodReference: redactReference(receipt.lastKnownGoodReference),
    externalBackupReferences: {
      configuration: redactReference(receipt.externalBackupReferences.configuration),
      runtimeState: redactReference(receipt.externalBackupReferences.runtimeState),
    },
    canaryReferences: {
      configuration: redactReference(receipt.canaryReferences.configuration),
      runtimeState: redactReference(receipt.canaryReferences.runtimeState),
    },
    capabilityProfiles: [
      {
        name: "builder",
        purpose: "Build and package the pinned source commit in a clean room.",
        commands: [...BUILDER_COMMANDS],
        activationAuthority: false,
      },
      {
        name: "canary",
        purpose: "Validate the candidate with isolated external config and state.",
        networkBoundary: "loopback-only",
        commands: [...CANARY_COMMANDS],
        activationAuthority: false,
      },
      {
        name: "activator",
        purpose: "Explicitly select the candidate outside this tool, then restart and verify.",
        requiresExplicitActivation: true,
        command: receipt.commands.activate,
        healthCommand: receipt.commands.health,
      },
      {
        name: "rollback",
        purpose:
          "Restore the last-known-good artifact and backups from outside the candidate lane.",
        executionBoundary: "outside-candidate-lane",
        command: receipt.commands.rollback,
        healthCommand: receipt.commands.health,
      },
    ],
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const action = argv[0];
  if (!new Set(["create", "validate", "plan"]).has(action)) {
    throw new Error(`unknown action: ${action}`);
  }

  const options = { action };
  const flags = new Map([
    ["--receipt", "receiptPath"],
    ["--source-commit", "sourceCommit"],
    ["--candidate-ref", "candidateReference"],
    ["--lkg-ref", "lastKnownGoodReference"],
    ["--config-backup-ref", "configurationBackupReference"],
    ["--state-backup-ref", "runtimeStateBackupReference"],
    ["--canary-config-ref", "canaryConfigurationReference"],
    ["--canary-state-ref", "canaryRuntimeStateReference"],
  ]);
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags.get(flag);
    if (!key) {
      throw new Error(`unknown option: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    options[key] = requireValue(argv, ++index, flag);
  }

  if (!options.receiptPath) {
    throw new Error("--receipt is required");
  }
  if (action === "create") {
    for (const [flag, key] of flags) {
      if (flag !== "--receipt" && !options[key]) {
        throw new Error(`${flag} is required for create`);
      }
    }
  } else if (seen.size !== 1) {
    throw new Error(`${action} accepts only --receipt`);
  }
  return options;
}

export function run(argv, output = process.stdout) {
  const options = parseArgs(argv);
  if (options.help) {
    output.write(usage());
    return;
  }

  let receipt;
  if (options.action === "create") {
    receipt = createReceipt(options);
    writeReceipt(options.receiptPath, receipt);
  } else {
    receipt = readReceipt(options.receiptPath);
  }
  output.write(`${JSON.stringify(buildDryRunPlan(receipt), null, 2)}\n`);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`main-workspace-release-lane: ${error.message}\n`);
    process.exitCode = 1;
  }
}
