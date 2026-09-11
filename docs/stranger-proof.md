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

This does not establish human stranger acceptance, a model/canon proof, or
live-connector qualification. Seven- and fourteen-day observation are optional
post-readiness diagnostics under the [current decision](decision-log.md#owner-amendment-to-readiness-2026-09-05).
It is automated evidence
that the built artifact can perform the deterministic local recovery path
outside its source checkout.

Native proof now resolves a closed host/target registry and refuses foreign
artifacts. Its receipt additionally binds Bun version and the checksums of all
packaged files plus the checksum manifest. A macOS arm64 package must be proved
on an actual macOS arm64 runner; cross-compilation and Linux fixture results do
not count. The manual workflow requires confirmed existing runner allowance.
Its explicit `native_lifecycle_only` branch installs an ephemeral fixture through
the native user service manager on both hosts; ordinary artifact and adapter
checks do not. Neither branch supplies real-account or human stranger evidence;
see [native-build.md](native-build.md).

## Effective SQLite engine evidence

Status: shipped

New packages use `kizuki.artifact-proof/v3`; legacy five-file packages retain
`kizuki.artifact-proof/v2`. Both run the same engine and journey checks. After initialization, before
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
acceptance from the runner's Bun version. Historical `BUILD.json` retains the
four-field `kizuki.release-build/v1` contract. New packages use Build V2 and
include `LICENSE` and `THIRD-PARTY-NOTICES.txt` alongside the original five
files. The checksum manifest covers six members; proof V3 binds all seven.
Its `distribution_identity` binds the validated inventory in BUILD to the
exact supplied notice bytes. Cross-version package/proof pairs are refused.

Each new build inventories positive-output inputs from its two actual native
compiles, pinned npm lock identities, Bun revision and embedded assets.
`inventory_status` describes recorded material coverage. The current Bun
and embedded-asset gaps remain `observed_with_unresolved_materials`;
`distribution_assessment` is always `not_performed`. A successful execution
proof does not resolve missing notices or grant distribution approval.

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

Policy v2 also admits the [observed Apple vendor identity](sqlite-vendor-qualification.md)
only for macOS arm64, Bun 1.3.14 and kernel 24.6.0. That entry is based on native
signature, system CLI, SDK header and matching runtime observations. It is not an
upstream SQLite source commit or an audit of Apple's private changes. Other
targets, runtimes, kernels and version/source-ID pairs do not inherit this entry.

Historical v1 receipts remain readable with their original fixture scope and
explicitly lack engine proof. The offline acceptance evaluator and fixture
observer share the closed receipt and ordered-step validator. Neither a
consistent receipt nor its reported engine identity independently attests a
hostile binary, the loaded library's path/hash, or a future owner deployment.
Linux CI retains the package and available proof receipt for seven days,
including failure receipts, for independent rehashing.
