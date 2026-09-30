# Service installation and recovery

`kizuki init` installs the user service unless `--no-service` is explicit or no
supervisor is available. `kizuki serve --install` activates the definition from
the currently invoked executable. Repeating it replaces the running definition;
it does not merely enable an older process. Keep installed executable versions
at stable paths until an upgrade has passed its own runtime checks.

Installation succeeds only after the supervisor reports both active and enabled.
An unavailable supervisor is reported as unknown. `serve --uninstall` must confirm
that the service is stopped and disabled before removing its definition or
recording the opt-out. Neither command deletes the vault or captured evidence.
Masking or disabling enablement does not establish that a service stopped.
Unknown activity and transitional states retain the definition and installed
intent; the command refuses to claim successful removal.
Removing or restoring a systemd definition also reloads the manager's definition
cache and checks the resulting runtime state before finalizing intent. A failed
reload keeps recovery pending until a later invocation can prove restoration.
When uninstalling a stopped systemd service that retains a failure record,
Kizuki resets that unit's failure record before removing the definition. It
checks the stopped state again; it does not reset failures for other units.
Installing over a failed systemd unit likewise resets that unit's failure
record, and with it the start-limit count, after the stop and before the start,
so a repeated install never fails with "start request repeated too quickly".

## A copy of a vault does not own the service

The unit name carries only the vault id, and a copy of a vault has the same id.
`serve status`, `serve --install`, `serve --uninstall` and doctor therefore read
the `--vault` path the installed definition launches and compare it with the
vault being asked about. When that path is another existing vault with the same
id, status reports the service as absent for this vault and names the other
path, and install and uninstall refuse without touching the definition or the
supervisor. Run the loop on the copy in the foreground with
`kizuki serve --vault <copy>`, or manage the service from the vault it serves.
A definition that names no vault, or names a vault that no longer exists, is not
treated as another live vault, so a moved vault can reinstall over it.
A definition that cannot be read safely (for example a symlinked one) is
reported as unknown for this vault, never as another vault's unit. The app
shows the same state as a copy and does not offer to enable the service.
`serve stop` acts on the stop marker inside the vault it is given, never on a
supervisor unit.

Known limit: a running vault that is copied byte for byte also copies its
`.kizuki/serve.pid` marker. On the copy, `serve status` can print the original's
pid and `serve stop` can answer `queued`, although the copy has no running loop.
Nothing outside the copy is controlled, so treat those two lines as stale
marker content until the loop runs on the copy.

## Restart limits and startup refusals

The systemd unit restarts on failure, at most `StartLimitBurst=5` starts per
`StartLimitIntervalSec=900`; past that, systemd leaves the unit failed with
result `start-limit-hit` instead of looping. A startup refusal that repeats on
every start exits 78, and `RestartPreventExitStatus=78` means systemd does not
restart it at all. Only these refusals exit 78:

| Refusal | Cause | Fix |
| --- | --- | --- |
| `unsupported_platform` | Service custody needs Linux x64 | `kizuki serve --uninstall`, then run the loop yourself |
| `not_supervised` | The launch carries no proof the unit started it | Start it through systemd, or run the loop yourself |
| `root_user` | The unit runs as root | Reinstall it as the vault's owner |
| `vault_mismatch` | The unit's vault path or id no longer binds this vault | `kizuki serve --install --vault <vault>` |
| `migration_required` | The ledger is from an older release | The `kizuki init` command the message names |

An unproven custody check and a custody broker that is not ready in time exit
1: under the unit's CPU quota a slow start can recover on the next attempt, and
the start limit bounds the loop when it does not. The main process waits for
the broker for the whole READY window the launcher allows.

When an installed unit is not running, doctor reads the unit's own `Result` and
`ExecMainStatus` from `systemctl --user show` and prints the command that
follows from them: the reinstall command after an exit 78, `systemctl --user
reset-failed <unit> && systemctl --user start <unit>` after `start-limit-hit`
or any other failed result, and `systemctl --user start <unit>` for an enabled
unit that stopped cleanly. `doctor --json` reports the same values as
`serve.supervisor_exit`.

## The daemon and owner commands share one ledger

The installed service and any owner-invoked command write to the same SQLite
ledger, which admits one writer at a time. Rails take the write lock for the
length of one batch and never hold a write transaction across a network or
model call, and every connection opens with a bounded busy timeout, so `sync`,
`backfill`, `import`, `query` and `context` keep working while the service
runs. A contended batch is retried within a bound and resumes from its
checkpoint.

When a writer outlasts every retry, the command stops with `lease_held`, names
the process holding the writer lease and says that running the same command
again resumes from the last checkpoint. Stopping the service is not required
for ordinary capture; it remains the way to release a lease held by a stuck
process. The MCP adapter refuses the same case as `busy` with a retry hint.

A writer never takes the service down. `backfill`, `sync` and `import` record
themselves as the running ingest, and while a service is running they leave the
ledger free for 150 ms after every 250 ms of writing, so the service's rails
interleave with them instead of waiting behind them. When a rail still meets a
ledger it cannot outwait, that pass is skipped: the receipt stops as
`ledger:lease_held` and names the holder, the schedule is not advanced, and the
service waits 1 s, then 2 s, doubling to at most 30 s, before it tries again.
The service logs `ledger_held` once when this starts and `ledger_free` when its
next write succeeds. Doctor calls a rail down only after five skipped passes in
a row, and its reason names the holder. A service that is started, or restarted
by its supervisor, while a writer holds the ledger waits and starts again inside
the same process (`start_held` in its log) instead of exiting, so the
supervisor's start limit is not spent on something that clears by itself.

A stop takes seconds: it aborts a model request in flight instead of waiting for
it. The longest thing a stop can still wait for is one connector call, which the
host bounds at 60 seconds, so the unit's `TimeoutStopSec=90s` is that bound plus
a 30 second margin and does not depend on `[ports.llm] timeout_ms`.
Connector draining finishes and checkpoints the current batch, then starts no
new batch or source. A stop also cancels startup backoff. If the ledger remains
held during final sealing, the daemon exits after bounded cleanup and leaves
the existing seal intact for the next successful writer to advance; it never
starts the daemon again. Doctor reads the bounded journal tail for pending rail
receipts and counts each run once, including while the writer is still active.

Definitions and service intent use bounded private files, atomic replacement and
directory synchronization. A process lock serializes changes for one vault. A
private transaction snapshot retains the previous definition and intent until
activation or removal is confirmed. Failed changes restore the previous
configuration when possible. If recovery cannot confirm the service transition,
the snapshot stays pending and doctor reports it. Retry the same install or
uninstall operation with the original service home after resolving the reported
supervisor failure; the command first resolves the pending transaction.
Recovery is bound to the original vault identity, vault location and unit location.
If any changes, recovery retains the journal and refuses to touch another service.
An unknown or inconsistent prior supervisor state prevents a new change. Invalid
intent is reported as unknown and unhealthy; it is never silently treated as an opt-out.

Removing a loaded macOS service with a confirmed nonzero exit uses a persistent
removal request. If removal is interrupted, the next invocation resumes unloading
the service and removing its definition. It never restarts the failed service as
part of recovery. The request remains until absence, removal and the opt-out are
confirmed. A changed definition or unknown manager state retains the request and
refuses further changes. After recovery finishes, an explicit install may start
the currently selected executable.

On Linux, a valid absolute `XDG_CONFIG_HOME` selects the configuration root, with
units in `systemd/user` below it. Otherwise the root is `$HOME/.config`.
Relative XDG paths are ignored, as required by the
[XDG specification](https://specifications.freedesktop.org/basedir/latest/).
macOS uses `$HOME/Library/LaunchAgents`.

Symlinked, shared-writable, hardlinked and non-owned service files are refused.
Native qualification must run against the exact candidate on both Linux and
macOS, including process locks, installation, upgrade, restart and removal.
Synthetic command-adapter tests do not establish that a service is installed on
a user's machine.

`serve stop` queues a private request for the current daemon instance and reports
`stop request queued`; it does not signal a PID or claim the process has exited.
The daemon checks the request between rails and within one second while idle,
finishes an active rail, and releases its runtime, process marker and writer lease.
Concurrent requests are idempotent. A busy writer is retried for up to one second;
continued contention reports a retryable error. Malformed, legacy or unsafe
control files are refused, and requests for an old instance cannot stop a successor.
The supervisor may restart the daemon according to its configured policy.
Use `serve --uninstall`
when the intended result is removal from automatic supervision.
