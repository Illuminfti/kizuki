# Canon capacity

Implemented behavior: canon has a configurable live-page ceiling for new
writes and independent resource budgets for complete reads. Query, context,
rebuild, export and purge continue at and above the writer ceiling.

## Configuration

```toml
# <vault>/.kizuki/serve.toml
[canon]
max_live_pages = 20000
# Optional resource budgets, chosen for available memory:
max_scan_files = 40000
max_scan_bytes = 163840000
```

`max_live_pages` defaults to 20,000 and accepts integers from 100 to 250,000.
The default scan file budget is the larger of 40,000 and twice the live ceiling.
The default byte budget is the larger of 64 MiB and 4 KiB per scan file.
Lowering the writer ceiling never lowers those defaults below their floors.
Explicit `max_scan_files` accepts 100 to 1,000,000; `max_scan_bytes` accepts
65,536 to 1,073,741,824. Absent or invalid values use their defaults, as does an
unreadable, malformed or oversized configuration file.

Resource budgets include archived and invalid candidates. They bound the
complete inventory needed for provenance, purge and backup. A page over 1 MiB
or nested deeper than eight segments is withheld and reported. Export also
retains its separate directory-entry and receipt bounds; see
[export inventory](export-inventory.md). Retrieval rebuild has its own resource
budget, described in [CLI rebuild](cli.md#rebuild).

## Live and archived pages

A page with `status: archived` is absent from live serving and derived indexes
and consumes no live slot. Doctor counts it separately. Maintenance walks keep
it available for provenance, undo, purge and export. A draft page reserves a
slot even though it is not served. Root `archive/` holds receipt preimages;
those revisions were already excluded from the canon page walk and are not
included in the archived-page count. Export includes receipted preimages.

## States and next steps

Doctor prints `canon pages live=N archived=M ceiling=C state=...` and exposes
the same fields plus scan budgets under `serve.canon` in JSON.

- `ok`: live count below 80 percent of the writer ceiling.
- `near`: live count at or above 80 percent; doctor names the next step.
- `full`: live count reaches the ceiling. New live pages are held with
  `canon_ceiling`; reads and edits that do not add a live page continue. The
  write pass reports the refusal once and leaves held claims live and unwritten.
  Raise `max_live_pages` or archive obsolete pages through the receipted writer.
  At the maximum, doctor points at source purge.
- `scan_limited`: the inventory reached a resource budget. Counts are lower
  bounds. Raise `max_scan_files` or `max_scan_bytes` within available memory
  and retry. Incomplete inventories still fail closed; purge never deletes
  against a partial scan, and creation refuses with `canon_scan_incomplete`.

Reactivating an archived page requires a free live slot. Receipted undo remains
available. Archive changes and existing-page edits use the same writer and
receipt path; this setting creates no additional write path.

Configuration is local to the vault and is not included in an export. Capacity
is established by a fresh walk under the cooperating writer fence before a
new live page is written; no persistent counter or migration is needed.
