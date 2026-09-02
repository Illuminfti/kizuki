# Kizuki Gauntlet

An intentionally small local control plane for an agent campaign. It stores a
hash-chained append-only event ledger and a SQLite WAL projection, but it does
**not** launch Codex, Claude, Cursor, Grok, network clients, GitHub calls, or
write into a target repository. Every harness adapter runs only its fixed,
bounded version probe; execution is disabled. A passing version probe means
only that a local executable ran: authentication remains `unknown`, route
readiness remains unproved, and the surfaced status reports both as not ready
until an operator
persists an independently obtained, version-bound receipt with
`record-adapter`. The controller hashes the supplied evidence file and current
executable itself, requires the fixed version probe to match, and expires the
attestation after a bounded TTL. It never performs the route test itself.

Low-level process/worktree proof types exist as an unwired library for the next
implementation phase. They are not imported by the CLI or systemd service,
cannot be enabled in `config.json`, and provide no OS sandbox. Real harness
execution remains disabled until separately reviewed scheduler, sandbox, and
adapter wiring is merged.

## Safety model

- State defaults to `/home/ubuntu/.local/state/kizuki-gauntlet` (outside a
  repository). Config must use an absolute state path.
- The observer refuses non-loopback configuration and binds to `127.0.0.1:8765`
  only. It exposes no write routes and constructs every response from a small
  explicit field allowlist; raw event payloads and free-form evidence stay private.
- The disk breaker requires 35 GiB free. `max_running` is initially four, a
  future capacity ceiling; this bootstrap build starts zero workers.
- Leases have a scope, controller epoch, TTL/heartbeat and monotonically
  increasing fencing token. Stale holders cannot release or heartbeat a lease.
- Tasks use row-version compare-and-swap. Receipts require a lowercase exact
  40-character commit SHA and nonempty test evidence.
- `reconcile` reads local Git references/worktrees only. It deliberately does
  not contact GitHub and marks remote PR inventory unavailable.
- Persisted adapter receipts capture the exact live `--version` output and
  executable hash at recording time. They expire automatically; any harness
  upgrade requires a new receipt before the attestation can be refreshed. The
  observer also verifies the executable hash once at controller startup; it
  never touches a harness during a request.

## Quick start

```sh
python3 gauntlet.py --state-dir /tmp/gauntlet init
python3 gauntlet.py --state-dir /tmp/gauntlet doctor
python3 gauntlet.py --state-dir /tmp/gauntlet probe
python3 gauntlet.py --state-dir /tmp/gauntlet reconcile /path/to/kizuki
# Persist only a separately captured, non-secret receipt:
python3 gauntlet.py --state-dir /tmp/gauntlet record-adapter codex \
  --version 'codex-cli 0.152.1' --auth-status READY --route-status READY \
  --evidence-file /absolute/path/to/sanitized-receipt.txt \
  --reason-code ISOLATED_ROUTE_PROBE --ttl-seconds 21600
python3 gauntlet.py --state-dir /tmp/gauntlet serve --port 8765
python3 -m unittest discover -s tests -v
```

Observer endpoints are `/v1/health`, `/v1/campaign`, `/v1/campaigns`,
`/v1/tasks`, `/v1/tasks/<id>`, `/v1/adapters`, `/v1/reconciliation`, `/v1/incidents`,
`/v1/receipts`, and `/v1/events?after=N`. POST/PUT/PATCH/DELETE return 405.
Event pages are oldest-first with a maximum of 100; continue from the last
returned sequence number until the page is empty.

Deploy by copying `config.example.json` to `config.json`, then install the user
units in `systemd/`. This is a fail-closed observer/bootstrap, not an autonomous
executor or merge train. `init` prints the single campaign ID; pass that ID and
the campaign version returned by `status` to state-changing commands.

For Grokbot or another local observer, use `bin/kizuki-gauntlet-status`. The
service is intentionally unreachable off-host; remote observers must enter over
an authenticated SSH route and query loopback. Never expose port 8765 publicly.

See [RUNBOOK.md](RUNBOOK.md), [ARCHITECTURE.md](ARCHITECTURE.md), and
[`config.example.json`](config.example.json).
