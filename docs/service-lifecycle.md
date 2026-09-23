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
