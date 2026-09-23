# Changelog

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
  Exact stages are removed, foreign stages are quarantined and never deleted,
  and unsafe stages hold recovery.
- A held recovery no longer stops `kizuki serve`: the other rails keep
  running, and `doctor` and `recover` report the reason and the next step.
- Startup refusals that a restart cannot fix exit 78, and the user unit does
  not restart on that status. The unit also gains a start limit and
  `MemorySwapMax=0`.
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
