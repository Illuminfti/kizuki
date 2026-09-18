# Copied-package file import proof

This synthetic fixture harness exercises the compiled CLI for eight local export
formats: ICS, Markdown folders, ChatGPT, Claude, X archives, WhatsApp, Pocket and
Omnivore. It uses serialized files, explicit source consent and separate temporary
vaults. It accesses no account and supplies no live-account, unfamiliar-user or
overall release credit. It writes the acceptance receipts for the eight
`connector.<id>` gates whose C3 evidence class is `file-import`; those gates stay
`UNVERIFIABLE` until the evaluator can distinguish an executed receipt from an
authored one (see [release-acceptance.md](release-acceptance.md)). The ninth
witnessable connector, `kizuki.screenpipe`, has its own
[local-source proof](screenpipe-proof.md).

Build and prove one package, then run the file-format proof against those bytes:

```sh
bun run build:release
bun run smoke:release
bun run proof:artifact -- --report /tmp/kizuki-artifact-proof
bun scripts/file-import-proof.ts --artifact dist/kizuki-0.1.0/bun-linux-x64-baseline --artifact-proof /tmp/kizuki-artifact-proof/receipt.json --report /tmp/kizuki-file-import-proof
```

Use the matching native target directory on macOS. The source checkout must remain
clean at the package's exact source revision. The harness verifies the seven-file
Build V2 package and artifact proof V3, copies the package outside its checkout,
and rechecks both copies after every command. No service is installed. The child
environment uses a fresh home, configuration and UTC timezone; it inherits no
credentials or model settings. The qualified runner additionally denies network
access and uses no host mounts.

For each format, a successful import must store exactly one event. Public ledger
query must return exactly its distinct sentinel with connector provenance and
private sensitivity through the normal query path. Deterministic capture and subject
proposals must total two (three for the WhatsApp sender/thread fixture). A second process imports the unchanged files and must store
zero events and errors; ICS, WhatsApp, Pocket and Omnivore replay one snapshot
event as one duplicate, while the other formats drain their saved cursor with
zero duplicates; query identities and public source
identity must remain stable. Public connection status exposes final-batch counts
and time (zero stored for formats that finish with an empty drain batch), not the underlying cursor, so this proof claims observed resume behavior
without claiming inspection of a protected cursor.

The same public CLI then revokes the source, checks query absence, completes
physical revocation maintenance, verifies the purged status and absence, and
refuses capture when the unchanged source is imported again without a new grant.
Each format also receives a separate malformed source. Markdown invalid UTF-8 and
partial ChatGPT/Claude exports must report failure; valid records in a partial
export remain queryable, and repeating it must not create duplicate evidence.
Malformed X and Omnivore exports must be refused before enrollment. ICS, WhatsApp
and Pocket parse during capture; these must return a failed run with zero stored
events and retain a public failed-run summary. Their retry must fail again without
creating evidence. Empty and post-revocation queries explicitly permit the
documented degraded floor to test absence. Only post-purge and denied-reimport
absence may carry `index-behind-ledger`, because physical erasure changes the
event count recorded by the CLI cursor. Other degradation fails. Positive queries
require status `ok`, no degradation and no warnings; they do not use this flag. Every expected nonzero
exit is checked explicitly; unexpected output, counts or missing steps fail the
proof rather than receiving success credit.

`receipt.json` uses `kizuki.file-import-fixture-proof/v1`. It binds the source,
producer files, all package hashes, upstream artifact proof, reference day, every
synthetic source/policy file hash and command observations. ICS uses the day after
the recorded reference day, keeping its event inside the calendar import window.
The output retains hashes and bounded observations rather than query text. On a
failure, the private `synthetic-diagnostics.json` contains bounded stdout/stderr
from these generated inputs only. Temporary vaults and source files are removed.
The report directory must be new and is never overwritten.

Beside that diagnostic receipt the run writes `connector-evidence/`: one
`kizuki.connector-evidence/v1` receipt per format, named by the connector id the
frozen C3 catalogue uses, plus `index.json`. Each receipt declares
`evidence_class: "file-import"`, names the producer files the evaluator pins, and
lists the executed steps — capture, idempotent repeat, revoke, the refusal that
follows it, and physical purge with its receipted status. A format whose cases
did not all pass keeps its receipt with `acceptance_credit: false`, which the
evaluator refuses outright rather than skipping. A format the harness never
reached emits no receipt and names its blocker in `index.json`'s `unresolved`.
The evaluator's receipt schema is closed, so the observed row counts and the
honest limits each importer's own behaviour showed are recorded in `index.json`
beside the receipts rather than in them. A live-account connector id is refused
by the producer: a file import cannot stand in for an account.

Verification: `bun test scripts/file-import-proof.test.ts scripts/connector-evidence.test.ts`
checks the fixture inventory, the refusal oracles and the promotion path. Actual
usability requires running the harness against the compiled package; parser tests
alone do not establish that result.
