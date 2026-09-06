# Artifact isolation proof

`bun run proof:artifact -- --report DIR` is an automated release prerequisite.
It copies the checksummed package for the matching supported native host out of
the checkout, starts
with a clean home and Kizuki configuration, and records a machine-readable
receipt at `DIR/receipt.json`.

The proof runs a synthetic local fixture through `init`, CLI doctor, MCP health, Markdown import,
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

## Effective SQLite engine evidence

The producer writes `kizuki.artifact-proof/v2`. After initialization, before
importing the synthetic source, it runs the copied `kizuki doctor --json` and
starts the copied `kizuki-mcp --owner`. The MCP session completes initialize,
requests `system_health`, closes stdin, and waits for process exit. Both
existing product surfaces read SQLite identity from their open ledger handle.
Each returns the versioned `kizuki.sqlite-runtime/v1` fragment: child Bun
version, SQLite version and SQLite source ID.

The receipt binds each observation to that copied executable's SHA-256.
Both executables and the original package are checked before and after use.
Child Bun versions must match BUILD provenance; the two SQLite identities
must agree and match the exact policy in
[`scripts/artifact-proof.ts`](../scripts/artifact-proof.ts). An unknown engine
is retained as an observation and fails qualification. It never inherits
acceptance from the runner's Bun version. `BUILD.json` remains the unchanged
four-field `kizuki.release-build/v1` contract.

Each diagnostic stream is limited to 16 KiB while reading. A 30-second deadline
covers process startup, protocol and exit; failures kill and reap the child.
Only parsed runtime fields and fixed status information enter the receipt.
Raw doctor/MCP health data and stderr are discarded. Doctor exit 1 with a valid
`error` envelope is recorded as unhealthy; it can still supply an engine
observation. All other proof steps require exit 0. Missing observations,
invalid responses and incomplete steps leave a failure receipt.

The initial policy admits the exact official SQLite 3.53.0 version/source-ID
pair, verified on 6 September 2026 against the
[SQLite release record](https://www.sqlite.org/releaselog/3_53_0.html).
[Bun documents](https://bun.com/docs/runtime/sqlite) system SQLite on macOS and
a static SQLite build on Linux/Windows. Native Darwin execution is therefore
required even with the same Bun pin. `host_kernel_release` records
`node:os.release()`; it is not a macOS product or patch version. Vendor builds
and backports require sourced policy entries rather than a guessed version
comparison. Re-observe after changing the host, OS, runtime or library.

Historical v1 receipts remain readable with their original fixture scope and
explicitly lack engine proof. The offline acceptance evaluator and fixture
observer share the closed receipt and ordered-step validator. Neither a
consistent receipt nor its reported engine identity independently attests a
hostile binary, the loaded library's path/hash, or a future owner deployment.
Linux CI retains the package and available proof receipt for seven days,
including failure receipts, for independent rehashing.
