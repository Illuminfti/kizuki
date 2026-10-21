# Scheduled backups

The daily `backup` rail is off until the owner configures an absolute destination
in the vault's `.kizuki/serve.toml`:

```toml
[backup]
dir = "/absolute/private/backup-directory"
retain = 7
```

The destination must be owner-only, outside the vault and reached without
symlinks. `retain` keeps between 1 and 365 archives; the default is seven.
Invalid configuration produces a failed receipt. The existing schedule can
also be disabled.

```sh
kizuki serve run backup --json
kizuki doctor --json
kizuki restore --from ARCHIVE --into EMPTY_DIRECTORY --verify
```

Each archive name includes its vault identity, UTC date and run receipt ID.
The rail uses the ordinary export path, verifies the manifest, then actually
restores into a private temporary directory. It checks event and receipt counts
and the restored vault doctor before removing that temporary copy. Only then
does retention remove older matching archives for the same vault. Unrelated
directories are preserved. Failed verification does not prune previous backups;
the latest verified archive is always kept, including after a clock rollback.

Credentials, agent tokens and derived or cache-class world-table streams are
excluded. Source export permissions remain in force. Missing permission yields
`backup:source:export_denied`; the rail never changes a grant. The manual
`kizuki backup` snapshot has a separate owner-custody recovery contract that does
not require export permission.

Every scheduled attempt retains a run receipt. Failures appear in doctor and
the daily brief with a bounded code, without private paths or record contents.
The rail makes no network or model request. Directory enumeration is bounded
to 2,000 entries; larger destinations require owner housekeeping.

## Verification

`packages/core/test/serve/backup.test.ts` covers export, restore and world query,
omitted secrets and caches, retention, unsafe destinations, consent refusal,
failed verification and retry. `packages/cli/test/backup.test.ts` runs the rail
and `restore --verify --into` through real CLI processes. The rail-registry
suite covers scheduling, receipts, writer leases and process interruption.
