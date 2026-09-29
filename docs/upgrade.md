# Upgrading an installed package

This runbook moves an installed release package to a newer one and back. It
covers a native package directory (the folder holding `kizuki` and
`kizuki-mcp`), not a source checkout. Every path below is a variable you set for
your own machine:

```bash
INSTALL_ROOT=...   # the folder that holds one directory per installed version
OLD="$INSTALL_ROOT/kizuki-<old version>"
NEW="$INSTALL_ROOT/kizuki-<new version>"
VAULT=...          # the absolute path of your workspace
BACKUP=...         # an absolute path that does not exist yet, outside $VAULT
```

Two facts drive the order of the steps.

- The service definition records the absolute path of the executable that ran
  `serve --install`. Installing from a symlink such as `current` records the
  path the operating system resolves it to, so always run install from the real
  version directory. Keep both version directories in place until the upgrade has
  passed its checks ([service lifecycle](service-lifecycle.md)).
- A newer build may migrate the ledger, and an older build cannot read a
  migrated ledger. Rolling back across a migration therefore means restoring the
  backup from step 2, not just switching binaries.

## 1. Stage the new version next to the old one

Unpack the new package into `$NEW`. Do not overwrite `$OLD` and do not touch the
vault yet. Check the package files with the checksum command in its `README.txt`,
then confirm what you staged:

```bash
"$NEW/kizuki" version
```

The output is `VERSION source=<40 hex source revision> built=<UTC time>`. Compare
the revision with `source_sha` in the package's `BUILD.json`. A build run from
source prints `VERSION dev` instead.

## 2. Back up the vault at file level

The database is copied with the SQLite online backup, which is safe while the
service runs. Everything else is copied with its modes preserved (`cp -a`; a
plain recursive copy loses the owner-only modes and the restored vault is then
refused).

```bash
mkdir "$BACKUP"
cp -a "$VAULT"/. "$BACKUP"/
rm -f "$BACKUP"/.kizuki/kizuki.db "$BACKUP"/.kizuki/kizuki.db-wal "$BACKUP"/.kizuki/kizuki.db-shm
find "$BACKUP" -name '*.sock' -delete
sqlite3 "file:$VAULT/.kizuki/kizuki.db?mode=ro" ".backup '$BACKUP/.kizuki/kizuki.db'"
chmod 600 "$BACKUP/.kizuki/kizuki.db"
sqlite3 "$BACKUP/.kizuki/kizuki.db" 'pragma integrity_check;'   # prints: ok
```

This copy contains credentials, agent identities and every source's text. Treat
it like the vault itself. It is not a `kizuki export` bundle, which leaves
agent identities and credential files out and needs every source to grant the
export purpose (see [source consent](cli.md#source-consent)).

## 3. Stop the old service

```bash
"$OLD/kizuki" serve --uninstall --vault "$VAULT"
```

This stops and disables the service and removes its definition. It keeps the
vault and every captured record.

## 4. Migrate the ledger if the new build asks

Run a command that opens the vault with the new package, for example
`"$NEW/kizuki" query "a phrase you know is in the vault" --vault "$VAULT"`. If it reports `migration_required`,
run the exact `init` command the message prints, using `$NEW`. That is the only
verb that migrates a ledger. Otherwise skip this step.

## 5. Install from the new real path and verify

```bash
"$NEW/kizuki" serve --install --vault "$VAULT"
"$NEW/kizuki" version
"$NEW/kizuki" doctor --vault "$VAULT"
"$NEW/kizuki" query "a phrase you know is in the vault" --vault "$VAULT"
```

`serve --install` succeeds only after the supervisor reports the service active
and enabled. Confirm the definition points at `$NEW` (systemd:
`systemctl --user cat "kizuki@<vault id>.service"`; the vault id is in
`$VAULT/.kizuki/vault-id`). Restart any long-lived `kizuki-mcp` process your
assistants started from `$OLD`: a running process keeps its old binary until it
exits.

## 6. Roll back

If nothing was migrated and the vault is intact, swap the service back:

```bash
"$NEW/kizuki" serve --uninstall --vault "$VAULT"
"$OLD/kizuki" serve --install --vault "$VAULT"
```

If the new build migrated the ledger, or the vault is damaged, or you want to
discard everything captured since the backup, restore the backup as well. Keep
the failed vault until the restore is verified:

```bash
"$NEW/kizuki" serve --uninstall --vault "$VAULT"
mv "$VAULT" "$VAULT.failed"
mkdir "$VAULT"
cp -a "$BACKUP"/. "$VAULT"/
"$OLD/kizuki" serve --install --vault "$VAULT"
"$OLD/kizuki" query "a phrase you know is in the vault" --vault "$VAULT"
```

Restore to the same `$VAULT` path so the service definition, your default vault
setting and any assistant configuration that names the path keep working. Delete `$VAULT.failed` and `$BACKUP` only once you no longer
need them.

## What is tested

`packages/cli/test/upgrade-path.test.ts` compiles two fixture packages with
different build identities, creates and imports a fixture vault with the first,
and walks steps 1 to 6 with the real commands: the staged directory, the
`sqlite3 .backup` copy, the service moving to the new path, the light rollback,
and the full rollback that discards later work. It runs against a synthetic
service manager, so it proves the definitions and data, not a real `systemd` or
`launchd` run. Both fixture packages come from the same source, so the test
does not exercise a schema migration; step 4 relies on the migration behavior
documented in [cli.md](cli.md#init).
