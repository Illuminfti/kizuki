# Changelog

## 1.0.1 (2026-09-24)

### Fixed

- The background service no longer runs out of memory during sync. Bun's
  `query()` cache keeps only 20 SQL strings, and every other query prepared a
  new statement that the connection tracked until the next full collection. A
  sync pass that wrote canon pages prepared about 32,000 statements per write
  and reached the service's 2 GiB limit, so the service was killed and
  restarted every 15 minutes. Each connection now keeps a bounded statement
  cache (512 SQL strings) in front of Bun's, and a statement left mid-iteration
  is finalized. On a vault with about 2,700 canon pages, one sync pass now
  peaks near 300 MB instead of passing 3 GB.
- The receipt for a sync run that was killed after its model call now says
  "sync interrupted after model decision" instead of blaming extraction.

## 1.0.0 (2026-09-23)

First public release. See [docs/CURRENT.md](docs/CURRENT.md) for what this
version ships and its known limits.

### World model

- Typed extraction (`kizuki.producer-response/v2`) admits source-anchored
  claims about Concepts and Situations when a model and a source grant that
  permits extraction are configured. Each call takes at most four records. A
  well-formed claim that breaks its own rules is dropped and counted instead
  of rejecting the whole response, and the configured model timeout bounds
  the call.
- `kizuki world` discovers Concepts and Situations and reads one card. The
  same projection is served as the MCP `world_view` tool, loopback HTTP
  `/v1/world_view` and the World views in `kizuki app`.
- `kizuki tell --world-claim` and MCP `correct` correct a world claim. The
  preview and the result name the predicate and the old and new values.
- The ledger schema is now version 33. `kizuki init <vault> --no-default`
  migrates an existing vault; `doctor` and `serve` name that command until it
  has run.

### Telegram

- Native sign-in uses the project app credentials compiled into the release
  package. The AES code is an MIT `node:crypto` implementation instead of a
  GPL dependency.
- Connect, the first state probe, `getMe` and sign-out each have a 45-second
  deadline. A network that never opens fails in seconds instead of hanging,
  and closed clients no longer leave a keep-alive timer running.
- Ctrl-C during sign-in prints one line, and a refused phone number gets an
  example of the expected format.

### Daemon and recovery

- Canon-write recovery classifies each staged file against the write intent.
  Exact stages are removed, foreign stages of an ordinary write are
  quarantined rather than deleted, and unsafe stages hold recovery.
  Withdrawal, purge and erasure also remove the stage traces of the receipts
  they erase.
- A held recovery no longer stops `kizuki serve`: the other rails keep
  running, and `doctor` and `recover` report the reason and the next step.
- Startup refusals that repeat on every start exit 78, and the user unit does
  not restart on that status; a possibly transient custody failure exits 1.
  The unit gains a start limit and `MemorySwapMax=0`, and doctor names the
  command that follows from the unit's last result.
- The broker removes stale custody sockets before it listens, and the native
  helper is compiled once per process instead of on every call.

### Fixes

- Historical World migration, ledger migration of deferred extract rows,
  audit page read cost, a module import cycle, and the legacy-revision
  provenance reason.

### Known limits

- The release package is an unsigned Linux x64 build. Nothing is published to
  npm. Other platforms run from a source checkout.
- Sign-in connectors, including Telegram, have no recorded live-account
  qualification on this version.
- World Slice, World Diff, revision resume, outcomes, attention, forecasts and
  Atlas are still roadmap.
