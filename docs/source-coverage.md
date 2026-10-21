# Source coverage

`kizuki doctor`, `kizuki doctor --json`, and both forms of `kizuki connect
status` disclose coverage for each enrolled source, including disconnected
sources. JSON nests the report under `coverage`. Human output includes a
coverage line and blind spots with a next step.

Counts come from the Core source-coverage module used by world reads. The
module reads ledger evidence and checkpoint receipts; it does not walk source
folders or contact providers. Doctor's existing connector health check remains
separate from coverage collection.

## What the counts mean

- `scanned`: Markdown records examined by the latest inventory, including
  failed file reads. Wiki mapping type exclusions have been examined and count
  here; directory exclusions have not.
- `ingested`: live ingested ledger records for the source, including retained
  revisions. This is neither the last batch's stored count nor a count of files
  currently on disk. Tombstoned records do not count.
- `excluded`: rule names and counts of matching entries encountered. A skipped
  directory counts once; the number of files beneath it is unknown. Configured
  rules with no observed match have count zero. Names are terminal-safe and
  bounded; excess rule names are grouped under `other_exclusion_rules`.
- `pending`: known events remaining in the current capture inventory. A truncated
  walk cannot count the unseen remainder.
- `failed`: observed failed entries or run errors. A failed directory represents
  unknown contents, rather than a count of failed files beneath it.
- `first_occurred_at` and `last_occurred_at`: earliest and latest occurrence
  instants of the ingested records, preserving the source timestamp spelling
  and precision. Bounds use the same instant ordering as grant windows.

Markdown-folder and legacy-wiki capture report inventories. Other connectors,
and checkpoints written before inventory support, report unknown counts
(`null` in JSON). No missing inventory is silently treated as zero.

## Completion and blind spots

`backfill_complete` is sticky once a successful backfill reaches exhaustion.
Folder connectors also set it when a sync reaches exhaustion, because their
sync scans the same history. Incremental provider sync does not make that
claim. A failed or truncated wiki scan does not declare completion.
`last_successful_pass_at` records a fully exhausted successful pass and
survives restart. `backfill_state` distinguishes never run, in progress,
complete, failed and unreadable; `last_error_class` supplies a safe error code.
A successful page alone is not a successful complete pass.

Blind spots include configured exclusion rules, attachment and non-Markdown
omissions in folder sources, disconnected or consent-paused sources, missing
inventories, truncated or failed scans, and sources without a recorded
successful complete pass. Completion refers to the connector's configured
scope; it does not mean Kizuki knows omitted content.

A successful folder drain reuses one bounded inventory across pages. A new
sync or a new connector instance scans again. Markdown continuation pages
reopen emitted files through the descriptor-bound reader and refuse byte
drift before capture. Directory identity or listing changes start a new
inventory; pinned directory metadata is checked without listing contents
again. This preserves capture of new identities during pagination. Cursor
mismatch and a terminal failure invalidate the continuation. Failed inventories also reuse their walk
while delivering readable pages, then report failure without declaring
completion. Wiki continuation uses the planned snapshot;
changes are discovered on the next pass.

## Scoped reads

Scoped Core coverage reads use the same event authorization and source
visibility rules as world reads. They return only sources with readable live
evidence, count only readable records and omit source inventory details.
The local owner diagnostics can also show enrolled sources that have never
captured evidence. Hidden sources, including malformed hidden checkpoints,
do not change a scoped reader's report or errors.

These diagnostics need no model and add no canon write path or network access.
