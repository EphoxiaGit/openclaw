---
summary: "Move Persona identity and bindings without merging capability authority"
read_when:
  - You are moving Personas into an OpenClaw deployment
  - You need an inventory, cutover, or rollback plan for Persona data
  - You need to separate Persona identity from Agents, TTS, memory, Dreams, security, and AIRI
title: "Migrate Personas"
sidebarTitle: "Persona Migration"
---

Use this guide to plan a Persona migration without creating an aggregate assistant authority.
A Persona carries user-facing identity, revisioned personality, and bindings to capability owners.
The underlying owners remain independently configured, secured, backed up, and verified.

## Capability owner matrix

| Capability                                     | Owner after migration             | Migration boundary                                                                                                                     |
| ---------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, personality, and Persona bindings    | Current Persona                   | Preserve revisions and references; do not copy provider, tool, or security configuration into the Persona.                             |
| Runtime, models, tools, skills, and channels   | Agents                            | Restore or configure Agents before binding Personas to them.                                                                           |
| Named voice profiles                           | TTS settings under Communications | Preserve named profile identifiers and restore provider credentials separately.                                                        |
| Durable Persona memory                         | Current Persona                   | Recover memory with compatible whole-set state restore. JSON export is inventory and evidence only; there is no per-record import API. |
| Memory consolidation and reflection            | Dreams                            | Restore Dreams policy only after its memory owner is available.                                                                        |
| Avatar and embodiment rendering                | Companion / AIRI                  | Presentation only. AIRI does not own Persona, conversation, Agent, memory, tool, or routing authority.                                 |
| Approvals, devices, access, and authentication | Security                          | Re-authorize through Security; never inherit authority from Persona data.                                                              |
| Runtime health, diagnostics, and recovery      | Debug and gateway operations      | Capture a healthy baseline and verify recovery separately from Persona import.                                                         |

## Inventory and export

1. Record every Persona, active revision, primary Agent, allowed delegate Agents, named TTS
   profile, memory scope, Dreams policy, and Companion / AIRI reference.
2. Inventory the corresponding Agents, models, tools, skills, channels, approval policies,
   devices, authentication methods, and runtime health checks under their owning product areas.
3. Use the supported export surfaces available in the source release. Keep Persona and memory
   exports as inventory and verification evidence, not as restoration inputs or proof that the
   destination has a matching importer.
4. Take a separate full deployment backup for rollback before changing the source or destination.
   A full backup can include sensitive configuration and state. Encrypt it, restrict access, record
   its release and deployment context, and do not attach it to tickets or public logs.

<Warning>
Persona exports must not contain resolved credentials or raw secret values. Preserve SecretRef
identifiers where the source supports them, then restore the referenced secrets through the
destination's supported secret-management flow.
</Warning>

## Restore in owner order

1. Confirm that the destination release can use the source backup and identify the
   deployment-specific restore procedure.
2. Restore the compatible whole-set state backup before selective reconfiguration. Whole-set state
   restore is the current recovery path for Persona memory. Persona Memory JSON is inventory and
   verification evidence only; there is no per-record memory import API.
3. Restore SecretRef targets and other credentials outside Persona data. Confirm that each owner
   can resolve its own secrets before continuing.
4. Verify the restored Agents, tools, skills, channels, TTS profiles, memory storage, Dreams,
   Security, and runtime operations.
5. If you are rebuilding instead of restoring the whole set, recreate Personas through the
   supported destination surface and start Persona memory empty. Bind only to Agents, named TTS
   profiles, and AIRI references that already exist.
6. Restore or reconfigure Dreams policy after the Persona and its memory owner are ready.
7. Re-authorize approvals, devices, access, and authentication in Security. Persona identity,
   mood, memory, Dreams, voice, and embodiment never grant permissions.

This guide intentionally does not provide a generic full-backup restore command. Backup formats,
restore procedures, and compatibility checks depend on the deployment and OpenClaw release. Use
the restore procedure documented for the deployment that created the backup.

## Verify before cutover

For each migrated Persona:

1. Confirm the expected identity, active revision, primary Agent, and delegate Agent allowlist.
2. Switch between at least two Personas and refresh the Control UI to confirm that identity remains
   stable.
3. Verify that Agent runtime, model, tools, skills, and channels are still managed under Agents.
4. Verify the named TTS profile under Communications, Persona memory under the current Persona,
   Dreams under Dreaming, and the presentation-only AIRI binding under Companion.
5. Review Security approvals, devices, access, and authentication, then check runtime health and
   recovery evidence under Debug.
6. Run representative conversations without granting new tools or permissions from Persona data.

Cut over only after the destination passes the inventory and verification checks and the source
remains available for rollback.

## Roll back as a whole set

If verification fails, stop the cutover and return to the complete pre-cutover deployment set.
Restore the full backup with the procedure for the source deployment, then verify Personas,
capability owners, secrets, memory, Security, and runtime health together. Do not combine
independent per-record restores into a partial assistant state, and do not treat a Persona export as
a substitute for the full deployment rollback.

## Related

- [Backup](/cli/backup)
- [Agents CLI](/cli/agents)
- [Control UI](/web/control-ui)
- [Devices CLI](/cli/devices)
- [Doctor](/cli/doctor)
- [Secrets management](/gateway/secrets)
- [Text-to-speech](/tools/tts)
- [Gateway authentication](/gateway/authentication)
- [Health checks](/gateway/health)
