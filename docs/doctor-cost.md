# Doctor loading and receipt retention

Doctor validates canon headers one file at a time. It keeps identities and
failure diagnostics, rather than page bodies or content hashes for the whole
vault. The CLI shares that scan between provenance, hash-drift coverage and
serve health. Hash drift still hashes its selected files. Duplicate identities,
malformed frontmatter, symlinks and the existing page, depth and byte ceilings
keep the full scanner's withholding behavior.

Rail counts, last successful runs and degraded streak lengths are SQL
aggregates over the existing bounded receipt windows. Calibration and daily
write counters are SQL aggregates too. Doctor retains a small recent window
for each rail's historical pending-work checks. Model attribution and failure
diagnostics stream the bounded sync history when a model is configured, keeping
only the last outcomes and counters. Truncation checks stream only model attempts
and stop at the first request that ends the streak. No report array for the
selected sync window is retained.

The run receipt JSONL file is a publication recovery journal. SQLite retains
run audit history for the configured retention period. `journal-prune` first
replays the journal, retires it when expired rows exist or its size exceeds
the journal ceiling, and deletes expired rows with one SQL range operation.
It does not serialize surviving history back into JSONL or shorten SQLite
retention to fit the journal ceiling. A publication lock serializes replay,
retirement and append-plus-row publication. A conflicting or unreadable row
prevents retirement. Pending capture-repair outbox rows are never age-pruned.
A crash after retirement can leave extra SQLite rows until the next prune;
replay cannot resurrect already-pruned history from the retired file.

The synthetic measurement fixture is
`packages/core/test/serve/doctor-cost-fixture.ts`. With a private temporary
directory set in `TMPDIR`, seed outside the measured process:

```sh
bun packages/core/test/serve/doctor-cost-fixture.ts seed "$TMPDIR/doctor-cost" 1
/usr/bin/time -f 'wall=%e peak_rss_kib=%M' bun packages/cli/src/main.ts doctor \
  --vault "$TMPDIR/doctor-cost" --json
```

Scale `1` seeds 14,000 run receipts and 7,300 pages with neutral synthetic
prose and ledger-linked provenance. Scale `10` multiplies both populations. An optional fourth argument `on`
configures a synthetic model reference with an absent environment credential,
exercising model-history reads without making model requests.
The existing 10,000-page and 64 MiB walk ceilings still apply: a larger vault
reports truncated coverage rather than claiming to have checked every page.
Measurements depend on the runtime entrypoint and machine load; this document
does not claim a universal wall-time or RSS guarantee. PR receipts report the
measured revisions and entrypoints.
