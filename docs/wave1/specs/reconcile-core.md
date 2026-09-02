# Lane: reconcile-core — land lane/core-spine on top of main

You are in the worktree for branch `lane/core-spine`. Read CONVENTIONS.md
first, then `core-spine.md` (the spec the branch implemented), then compare
`git log --oneline main..HEAD` (this branch's work) with
`git log --oneline HEAD..main` (what landed on main meanwhile — chiefly
commit 7d00de0 "Make the tombstone rail reachable end to end", which added
`ledger/checkpoints.ts` with a v2 migration, `cascadeTombstone` in
`staging/producers.ts`, deletion promotion in `staging/promote.ts`, CLI
changes in `packages/cli/src/main.ts`, README and CI edits — and the new
`packages/tui` package plus `purge_review` in `PROPOSAL_KINDS`).

## Objective

`git rebase main` (or `git merge main`; rebase preferred if the history stays
readable) and resolve every conflict so that BOTH bodies of work survive as
one coherent design, with all tests from both sides green. Rules:

1. **One migration v2.** Exactly one `version: 2` entry in
   `packages/core/src/ledger/db.ts` creating: `checkpoints` keyed by
   `PRIMARY KEY (connector_id, source_key)` with columns `cursor TEXT`
   (nullable = exhausted), `mode TEXT NOT NULL`, `updated_at`, `last_run_at`,
   `last_result TEXT NOT NULL` (JSON); `connections` keyed by
   `PRIMARY KEY (connector_id, source_key)` with `config`, `secret_refs`,
   `connected_at`, `disconnected_at`; `canon_holds`; and the promotions
   column additions (`kind`, `before_hash`, `after_hash`). `source_key`
   identifies one source within a connector (for file-based connectors the
   resolved absolute path; for account-based connectors the account id;
   `''` when a connector has a single implicit source). No database has
   shipped, so redefining v2 is correct; do not add a v3.
2. **One checkpoint API.** Keep the richer lane functions
   (`saveCheckpoint`, `getCheckpoint`, `listCheckpoints`) but keyed by
   `(connector_id, source_key)`; keep `readCheckpoint(db, connectorId,
sourceKey)` / `writeCheckpoint(db, connectorId, sourceKey, cursor)` from
   main as thin wrappers over the same table so main's CLI and tests keep
   passing unchanged. Same for connections: `saveConnection(db, connector_id,
source_key, config, secret_refs)` etc.
3. **Ingest runner uses the tombstone rail.** `runBatch` must call
   `cascadeTombstone(db, event)` for deleted events (main's semantics:
   withdraw pending proposals citing any event of the record AND file a
   `deletion` proposal per promoted page citing it) and report both
   `withdrawn` and `retractions_filed` in `RunResult`. `runBackfill`/`runSync`
   take `source_key` and read/write the checkpoint under it.
4. **One promote.** Deletion keeps main's semantics: the page stays at its
   path with `status: archived`, the prior revision copied under `archive/`
   by the vault writer's revision mode; drop the lane's "move the file"
   variant and any now-unused helper (`archivePage`) unless something else
   still needs it. Edit, merge and purge_review behave per the lane spec;
   receipts carry `kind`, `before_hash`, `after_hash` for every kind.
5. **CLI stays green.** `packages/cli/src/main.ts` on main uses
   `readCheckpoint`/`writeCheckpoint`/`cascadeTombstone`; touch it only as
   far as the unified core API requires (a following lane rewrites the CLI).
   The CLI e2e test must pass.
6. Keep every test from both sides; where two tests assert contradicting
   behavior, the rules above decide and you rewrite the losing test to the
   chosen behavior with a one-line comment saying which rule decided it.
7. No new dependencies; banned words rule; conventions as before.
8. **One canon walker.** main now also carries `src/search/`, `src/graph/`,
   `src/query/` and `src/agents/` (sibling lanes). If the search indexer or
   graph builder walks the vault with its own code, switch them to
   `listCanonPages`/`findPageById` from `src/vault/pages.ts` so the vault
   has exactly one reader; keep their tests green. Purge must also delete
   `search_docs` rows and `graph_edges` rows for purged events, using the
   real functions (`removeDoc`) instead of an existence-guarded SQL.

## Acceptance

```
git merge-base --is-ancestor main HEAD && echo BASED_ON_MAIN
bun run typecheck
bun test                                   # green, count ≥ (main's count + lane's new tests − duplicates)
grep -c 'version: 2' packages/core/src/ledger/db.ts   # prints 1
grep -rniE 'illumi|hermes|ika-hetzner|albedo|gbrain' packages/ docs/ README.md --include='*.ts' --include='*.md' --include='*.json'   # no output
git status --porcelain                     # empty
```
