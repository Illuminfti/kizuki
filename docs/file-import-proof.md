# Copied-package file import proof

This synthetic fixture harness exercises the compiled CLI for eight local export
formats: ICS, Markdown folders, ChatGPT, Claude, X archives, WhatsApp, Pocket and
Omnivore. It uses serialized files, explicit source consent and separate temporary
vaults. It neither accesses accounts nor supplies live connector, C3, unfamiliar
user or release acceptance credit.

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
private sensitivity. A second process imports the unchanged files and must store
zero events with zero duplicates or errors; query identities and public source
identity must remain stable. Public connection status exposes last-run counts and
time, not the underlying cursor, so this proof claims observed resume behavior
without claiming inspection of a protected cursor.

The same public CLI then revokes the source, checks query absence, completes
physical revocation maintenance, verifies the purged status and absence, and
refuses capture when the unchanged source is imported again without a new grant.
Each format also receives a separate malformed source. Markdown invalid UTF-8 and
partial ChatGPT/Claude exports must report failure; valid records in a partial
export remain queryable, and repeating it must not create duplicate evidence.
Other malformed formats must be refused before enrollment. Every expected nonzero
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

Verification: `bun test scripts/file-import-proof.test.ts` checks the fixture
inventory and refusal oracles. Actual usability requires running the harness
against the compiled package; parser tests alone do not establish that result.
