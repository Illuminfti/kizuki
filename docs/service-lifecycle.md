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

Definitions and service intent use bounded private files, atomic replacement and
directory synchronization. A process lock serializes changes for one vault. A
private transaction snapshot retains the previous definition and intent until
activation or removal is confirmed. Failed changes restore the previous
configuration when possible. If recovery cannot confirm the service transition,
the snapshot stays pending and doctor reports it. Retry the same install or
uninstall operation with the original service home after resolving the reported
supervisor failure; the command first recovers the previous configuration.
Recovery is bound to the original vault identity, vault location and unit location.
If any changes, recovery retains the journal and refuses to touch another service.
An unknown or inconsistent prior supervisor state prevents a new change. Invalid
intent is reported as unknown and unhealthy; it is never silently treated as an opt-out.

On Linux, a valid absolute `XDG_CONFIG_HOME` selects the configuration root, with
units in `systemd/user` below it. Otherwise the root is `$HOME/.config`.
Relative XDG paths are ignored, as required by the
[XDG specification](https://specifications.freedesktop.org/basedir/latest/).
macOS uses `$HOME/Library/LaunchAgents`.

Symlinked, shared-writable, hardlinked and non-owned service files are refused.
The native Linux package currently qualifies the process-lock boundary. macOS
packaging, lock execution, launchd activation and real install/upgrade/restart
proofs remain required qualification work. Synthetic command-adapter tests do
not establish that a service is installed on a user's machine.

`serve stop` sends a termination request and reports that request. The supervisor
may restart the daemon according to its configured policy. Use `serve --uninstall`
when the intended result is removal from automatic supervision.
