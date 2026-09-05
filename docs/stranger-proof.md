# Artifact isolation proof

`bun run proof:artifact -- --report DIR` is an automated release prerequisite.
It copies the checksummed Linux x64 native package out of the checkout, starts
with a clean home and Kizuki configuration, and records a machine-readable
receipt at `DIR/receipt.json`.

The proof runs a synthetic local fixture through `init`, Markdown import,
query, context, export verification, and clean-target restore. The receipt
records the build source SHA, target, platform, executable SHA-256, clean
execution paths, each command result, and any failure. It deliberately does
not inherit a real home directory, Kizuki configuration, or secret reference.
The restored query uses `--degraded`: retrieval indexes are intentionally
rebuildable and the proof records that transparent fallback while confirming
that restored evidence remains queryable and available to context.

Build an artifact first, then run:

```bash
bun run build:release
bun run proof:artifact -- --report /tmp/kizuki-artifact-proof
```

Pass `--artifact DIR` to check a different artifact directory. The artifact
must contain a valid `BUILD.json` and checksum manifest.

This is not a human stranger proof, a model/canon proof, live-connector
qualification, or a substitute for the seven-day rail observation and
fourteen-day estate-parity cutover required for 1.0. It is automated evidence
that the built artifact can perform the deterministic local recovery path
outside its source checkout.

Native proof now resolves a closed host/target registry and refuses foreign
artifacts. Its receipt additionally binds Bun version and the checksums of all
packaged files plus the checksum manifest. A macOS arm64 package must be proved
on an actual macOS arm64 runner; cross-compilation and Linux fixture results do
not count. The manual macOS workflow is cost-gated and does not activate launchd
or provide calendar/human stranger evidence; see [native-build.md](native-build.md).
