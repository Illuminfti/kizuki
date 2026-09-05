# Native recovery proof

Evidence date: 5 September 2026. This checked-in producer executes three fixed
synthetic recovery scenarios through a copied native package. It records
observations under local operator custody. A successful run does not establish
release acceptance, an installed service, real account authorization, human
usefulness, independent native execution attestation or calendar qualification.

## Run on a frozen native candidate

Use the repository's pinned Bun on the package's actual supported native host.
The checkout must be clean and its exact HEAD must equal `BUILD.json`'s source
SHA. The producer derives source code from its own checked-in location. It
accepts no alternate source checkout, scenario selection, actor declaration,
result, clock, threshold or timeout flags.

```bash
bun install --frozen-lockfile
bun run proof:recovery --artifact /absolute/retained/native-package --out /absolute/new-private-recovery-directory
```

Build and retain the package using [native build](native-build.md). Use physical,
absolute paths without symlink components, keep exclusive custody of the
package and receipts, and use a new output directory for every attempt.
Linux x64 and macOS arm64 require separate actual native runs. Unsupported
product behavior on either platform fails the scenario; it cannot be skipped
or relabeled as another platform's observation.

The producer verifies SHA-256 for `kizuki`, `kizuki-mcp`, `README.txt`,
`BUILD.json` and `SHA256SUMS`, then copies exactly those files to a private
physical temporary directory outside the checkout. It verifies both copies
and executes the copied CLI and MCP there. Each scenario uses a fresh vault,
home and config with `KIZUKI_SUPERVISOR=none`. The only listener is the fixed
loopback model-request counter used by the pending-decision case. No real
provider or external model address is accepted.

## What the three scenarios observe

| Scenario | Observations and limits |
| --- | --- |
| `retrieval-authority-recovery` | Four fixed source/model canon cases; native owner corrections; exact lexical recall and authority; diagnostic floor typo recall; embedded-engine typo recall; correction receipt, byte-identical undo and restored authority; rebuild and clean restore preserve retrieval. This is a fixed synthetic corpus, not an extraction-quality score or model inference evaluation. |
| `revocation-retained-consumers` | Two native-enrolled local sources; capture denial before Core fixture grants and idempotent capture afterward; real separate FTS and embedded PostgreSQL positive controls; immediate CLI and same-session MCP denial; full context replacement with a changed prefix hash; busy store pending, clean original session close, new-process two-store completion and retry; no source revival after rebuild; independent evidence and the external original remain. Specified Core ledger/claim inspection is not a comprehensive residual-byte scan. |
| `pending-decision-restore` | Constructed mixed-permission history with one allowed input, one denied input and one pre-existing deferred item; one synthetic constructor model call; export and clean restore preserve journal fields and model reference; missing mandatory current journal refuses without leaving a target; simulated v7 warning is explicit; copied CLI replay/retry make zero loopback model requests and preserve one claim, one receipt, exact provenance and two deferred members. This is constructed pending state, not reliable process interruption or a real historical v7 migration. |

Core fixture setup and inspection run in bounded same-revision child
processes. These use public Core APIs, plus only the named
`mineLiveDrafts`/`journalExtractBatch` constructors for the pending decision.
Every fixture child must exit before its consumer commands start, releasing
all Bun/SQLite statement handles. Receipts identify these as Core fixture
operations. They are not native product command successes or policy-file
custody proof. Local retrieval/model configuration and intentionally altered
backup copies are also explicit fixture operations.

CLI operations have fixed 30-second deadlines, one MiB stdout and 64 KiB
stderr limits. Output is bounded while reading. A deadline, overflow, early
MCP EOF, malformed response, unexpected request identity or failed clean
shutdown fails the run. Expected command refusals still require the specific
observed reason and cannot be satisfied by a timeout. MCP has one retained
session across revocation, ordered request IDs and a bounded close; its
lifetime also includes intervening CLI commands.

## Receipt and failure retention

The producer first atomically publishes private `attempt.json`. A normally
completed run writes `receipt.json` with schema
`kizuki.native-recovery-proof/v2`, including unsuccessful scenarios. A
preflight or producer failure writes `failure.json` when possible and never
creates a success receipt. Termination before a complete receipt supplies no
credit. Output is published only after complete bytes have been written and
synced, without replacing a destination. Publication or cleanup errors return
nonzero; a publication error can leave complete evidence in the new directory,
so use a fresh directory for another attempt.

The closed receipt binds the exact source SHA and tree, all package hashes,
original/copy equality, actual native host, pinned Bun and generator file
hashes including the entry point, fixture/process/evidence helpers, fixed
recipe, `.bun-version` and `bun.lock`. It records wall start/end and monotonic
elapsed duration, fixed operation templates with run-local path roles, child
output digests, typed observed checks, and completion/cleanup status. It omits
raw stdout, stderr, source paths and unrestricted diagnostic text.

The historical 33/37/8-step scripts were the design reference. Their v1 JSON
cannot be upgraded into this receipt: they lack the new generator/package
binding, fixed IDs and complete subprocess observations. Rerun the checked-in
producer on the chosen candidate. Counts are derived from the registered
recipe, not frozen historical totals.

## Use in acceptance inventory

Add a reference to a v2 [acceptance index](release-acceptance.md):

```json
{
  "producer": "kizuki.native-recovery-proof/v2",
  "target": "bun-linux-x64-baseline",
  "path": "/absolute/retained/recovery/receipt.json",
  "receipt_sha256": "<sha256-of-exact-receipt-bytes>"
}
```

The index's artifact entry must already verify for the same candidate and
package. The checker must run from the exact registered generator checkout. Every
registered local file must hash to the candidate Git blob; a reported HEAD
with modified trust-relevant files fails closed. Unrelated local documentation
or report files do not by themselves invalidate offline verification.
It validates the receipt offline and can populate five required automated
subgates for that target. All 49 gates stay visible; whole journeys, native
attestation, installed services, accounts, review, human usefulness, seven-day
owner observation and fourteen-day estate parity keep their separate gates.
A selected passing receipt does not disposition a previous failed attempt.
The current trusted finding-inventory and independent-review gates remain
blocking.

## Verification

```bash
bun test scripts/native-proof-process.test.ts scripts/recovery-artifact-proof.test.ts scripts/recovery-proof-receipt.test.ts scripts/recovery-proof-scenarios.test.ts scripts/go-no-go.test.ts scripts/extraction-quality-native.test.ts
bun run typecheck
bun run verify
```

Synthetic validator fixtures qualify rejection behavior only. The source
scenario test exercises real source CLI/MCP children and checks their observed
receipt fields, but issues no native artifact receipt. A copied native run on
an exact reviewed candidate is separate evidence.
