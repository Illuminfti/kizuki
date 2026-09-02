# Operator runbook

1. Create a dedicated state path outside any worktree, preferably an owned
   `/home/ubuntu/.local/state/kizuki-gauntlet` directory. Never place it in Kizuki.
2. Run `init`, then `doctor`. Do not proceed on a failed disk/crash/concurrency
   breaker.
3. Run `probe`; it uses each adapter's fixed `--version` argv under a short
   timeout and never passes a prompt, repository, identity, environment,
   credentials, or token.
4. If an approved operator has separately proved authentication and a real
   route, persist only the sanitized outcome with `record-adapter`. The receipt
   must name the exact version returned by `probe` and an absolute, regular,
   no-follow evidence file. The controller computes both evidence and executable
   SHA-256 values itself and expires the attestation. Never put credentials,
   account identity, prompts, or raw logs in the evidence. `QUOTA_BLOCKED` is a
   truthful route state. The observer re-hashes each receipted executable once
   at controller startup and reports readiness false if that identity no longer
   matches; request handlers never touch harness files.
5. Run `reconcile /path/to/kizuki` for a local Git inventory. It is offline:
   fetch or GitHub PR inspection is intentionally excluded.
6. Start `serve` only behind local host protections. It is an observer surface,
   not an API for scheduling agents.
7. Quiesce a campaign before maintenance: `quiesce <campaign-id>`. Existing
   leases naturally expire; do not delete ledger files.

## Deployment verification and rollback

```sh
install -d -m 0700 /home/ubuntu/.local/state/kizuki-gauntlet
install -d -m 0700 /home/ubuntu/.config/systemd/user
# Before replacing an existing deployment, save its Git revision, config, and
# units to a timestamped directory outside this checkout.
install -m 0600 config.example.json config.json
python3 gauntlet.py --config config.json init
python3 gauntlet.py --config config.json doctor
python3 gauntlet.py --config config.json probe
# Repeat per adapter only after a separate, bounded route check:
python3 gauntlet.py --config config.json record-adapter codex \
  --version 'codex-cli 0.152.1' --auth-status READY --route-status READY \
  --evidence-file /absolute/path/to/sanitized-receipt.txt \
  --reason-code ISOLATED_ROUTE_PROBE --ttl-seconds 21600
install -Dm0644 systemd/kizuki-gauntlet.service ~/.config/systemd/user/kizuki-gauntlet.service
install -Dm0644 systemd/kizuki-gauntlet-health.service ~/.config/systemd/user/kizuki-gauntlet-health.service
install -Dm0644 systemd/kizuki-gauntlet.timer ~/.config/systemd/user/kizuki-gauntlet.timer
systemctl --user daemon-reload
systemctl --user enable --now kizuki-gauntlet.service kizuki-gauntlet.timer
curl --fail http://127.0.0.1:8765/v1/health
bin/kizuki-gauntlet-status
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --request POST http://127.0.0.1:8765/v1/tasks
ss -ltnp | grep '127.0.0.1:8765'
systemctl --user is-active kizuki-gauntlet.service kizuki-gauntlet.timer
# This must fail with "controller already claimed" while serve is active:
python3 gauntlet.py --config config.json once
systemctl --user status kizuki-gauntlet.service kizuki-gauntlet-health.service
```

Expected receipts are HTTP 200 for health, HTTP 405 with `Allow: GET` for the
POST, a listener only on `127.0.0.1:8765`, active service/timer units, and a
nonzero duplicate-controller command. `config.json` contains no credentials
and remains mode 0600. Record the pre-deployment revision and backup directory
in the deployment receipt so rollback has an exact target.

`init` returns `campaign_id`, `state`, and `version`. Keep them: reconciliation
is persisted with `reconcile /path/to/kizuki --campaign <id>`, and promotion or
quiescing requires an explicit campaign ID and optimistic-lock version:

```sh
python3 gauntlet.py --config config.json reconcile /path/to/kizuki --campaign <id>
python3 gauntlet.py --config config.json promote <id> <version>
python3 gauntlet.py --config config.json quiesce <id> <version>
```

Built-in reconciliation keeps the campaign in `RECONCILING`, does not change
its version, and always records `safe_to_promote: false`. Do not run `promote`
until a separately reviewed reconciliation has accounted for every external
worktree and produced explicit promotable evidence.

Rollback is non-destructive: `systemctl --user disable --now
kizuki-gauntlet.service kizuki-gauntlet.timer`; preserve the state directory and
unit logs. Restore the exact previous controller revision, config, and units
from the recorded backup, run `doctor`, then restart.
Never delete or edit `events.jsonl` to force recovery.

Recovery: retain `events.jsonl`, stop the service, verify no controller owns the
lock, and archive `state.sqlite3`, `state.sqlite3-wal`, and
`state.sqlite3-shm` together into a mode-0700 timestamped directory. Then start
again. The service creates a fresh projection, claims a new controller epoch,
replays the complete ledger, compares every derived table to a deterministic
in-memory replay, and only then binds the observer. Never separate a SQLite
database from its WAL/SHM sidecars. The periodic `doctor` is intentionally not an
`ExecStartPre`: it must not prevent safe replay after a crash. If verification
fails, preserve evidence and open an incident; do not edit JSONL to make it pass.

Execution enablement is deliberately absent. Promotion only moves a campaign
from `RECONCILING` to `READY` after persisted evidence explicitly permits it;
the built-in offline reconciliation correctly records `safe_to_promote: false`.
A future executor needs an
explicit approved design, per-worktree sandboxing, path policy, command allow
lists, audit logging, secrets isolation, and an external merge authority.

The source tree contains unwired process/worktree proof mechanics for that
future phase. They do not enforce CPU, memory, or network limits and must not be
connected to real harnesses without an outer systemd/bubblewrap sandbox and a
new security review. Cursor's native CLI sandbox is not available on this VPS,
so outer containment is mandatory for any future Cursor execution.

Because the observer process owns the single controller lock, later
`record-adapter`, reconciliation, promotion, or quiesce operations require a
brief maintenance window: stop the observer, run the bounded command, then
restart it and verify health. Read-only `status`, `doctor`, and `probe` remain
available while the observer runs.
