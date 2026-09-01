---
name: backup-restore
description: Design, implement, or verify Kizuki backup and restore so a clean target can recover durable owner data without credentials, corruption, stale derived state, or unverifiable omissions.
---

# Backup and restore engineering

1. Inventory durable source-of-truth state, rebuildable derived state, secrets, ephemeral state, and external dependencies.
2. Define backup consistency point and behavior during concurrent writes.
3. Exclude plaintext credentials and secret material. Preserve only supported references when safe.
4. Include versioned manifests, counts, hashes, schema/version metadata, and provenance needed to verify completeness.
5. Make partial output unmistakably invalid and use atomic completion markers where appropriate.
6. Restore into an empty target first. Never require overwriting a healthy vault to prove restore.
7. Verify hashes, schema compatibility, path safety, permissions, canon readability, ledger integrity, connection/checkpoint semantics, and derived-state rebuild.
8. Test interruption during backup and restore, corrupted/truncated files, missing entries, duplicate restore, older supported versions, and insufficient disk.
9. Compare restored public behavior and manifests to the source using synthetic fixtures.

A backup feature is incomplete until clean-target restore has been exercised automatically.
