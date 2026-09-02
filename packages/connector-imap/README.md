# @kizuki/connector-imap

Read-only mailbox sync over IMAP4rev1 with implicit TLS. It signs in with an
app password, syncs INBOX plus whatever folders you pick, and never changes
anything on the server.

Connector id: `kizuki.imap`. Emits `email` events with a `personal`
sensitivity hint. Zero runtime dependencies: the IMAP client is a few hundred
lines over a Bun TLS socket, and the MIME subset is hand-written.

## What it syncs

Per configured folder, in configured order:

- every message, oldest UID first, in pages of 200 events per batch
- the decoded subject and the first `text/plain` part (falling back to the
  HTML part rendered as text)
- `From`, `To` and `Cc` as subjects; `Reply-To` and group syntax are ignored
- attachment **refs** only: section path, media type, filename, byte size.
  Nothing is ever downloaded or stored.
- message metadata: folder, UID, UIDVALIDITY, `Message-ID`, `In-Reply-To`,
  `References`, `Date`, INTERNALDATE, size, `List-Id`

A message larger than `max_message_bytes` (2 MiB by default) is captured
header-only, with `metadata.body_omitted: "size"`.

IMAP flags are captured nowhere. A `\Seen` toggle is not a change to the
message, and recording it would fork a ledger row every time the mailbox was
re-observed.

## Sign-in

Sign-in is interactive: the connector asks four questions through the host's
terminal, then offers a folder picker. The CLI verb that drives it is owned by
a CLI lane and is not on `main` yet; today the walk-through is exercised by
`enrollConnection` from `@kizuki/core` and by this package's tests.

The prompts, in order:

```
IMAP server host: mail.example.org
IMAP port [993]:
Username (usually your email address): you@example.org
App password:
Folders on the server: INBOX, Archive, Sent, Lists/dev
Folders to sync [INBOX]: INBOX, Archive
```

The host and port are validated before anything is dialled. The credentials
are proved against the real server before anything is written: a wrong app
password, an unreadable folder or a folder name that is not on the server
fails the sign-in and leaves no state behind.

Everything you typed is then handed to Kizuki as opaque bytes and stored in
`~/.kizuki/connections/<id>.state`, mode 0600. None of it — host, username,
folder list, least of all the password — is ever written to SQLite; the
ledger's CHECK constraints refuse to hold it.

To change the folder list, run the sign-in again through
`ConnectionStateStore.replace`. The connection keeps its identity and the
state file is replaced atomically.

## Provider support (checked 2026-09-02)

This connector authenticates with `LOGIN` and an app password over implicit
TLS. Check your provider's current documentation before assuming it works:
several large consumer mail providers have withdrawn app passwords for IMAP
and now require OAuth, which this connector does not implement and therefore
does not support. Self-hosted servers, most business mail hosts and most
independent providers still issue app passwords.

Revoking access is done at the provider, by deleting the app password. This
connector holds no remote credential of its own, so `revoke()` only drops the
copy in memory. Deleting the state file is the host's job when the owner
disconnects the source.

## Security

- Certificates are verified. A server whose certificate the system trust store
  does not accept is unsupported. There is no insecure switch, and
  `rejectUnauthorized: false` appears nowhere in this tree.
- The hostname is checked against the certificate by this package, because the
  runtime does not fail the handshake on a mismatch. Not one byte is written
  before both checks pass.
- Nothing in `src/` logs. A trace of a command line would carry the password.
- The password and username never appear in the manifest, an error message, a
  health detail, an event, or the cursor.
- `EXAMINE`, never `SELECT`. `BODY.PEEK`, never `BODY`. There is no `STORE`,
  `EXPUNGE` or `APPEND` anywhere in the client.

## Deletion and purge

A message that disappears from the server produces a tombstone. So does a
UIDVALIDITY change: every old record id is tombstoned and the mailbox is
re-walked under the new numbering.

`purgeSource("email:someone@example.org")` reports which records that person
appears in. It never claims to delete anything at the source, because it
cannot: this connector is read-only. Delete the mail in your mail client.

## Not implemented

STARTTLS on port 143 (implicit TLS only), `AUTHENTICATE`, XOAUTH2 and OAuth
providers, plaintext IMAP, IDLE and push, attachment download, flag or label
capture, sending or moving mail, Sieve, NNTP and POP3.

## Manual smoke test

Against a real account, with credentials in the environment and never on the
command line:

```
KIZUKI_IMAP_SMOKE_HOST=mail.example.org \
KIZUKI_IMAP_SMOKE_PORT=993 \
KIZUKI_IMAP_SMOKE_USERNAME=you@example.org \
KIZUKI_IMAP_SMOKE_PASSWORD=... \
bun test packages/connector-imap/test/smoke.test.ts
```

It connects, asserts `health()` is `ok`, and validates one backfill page. With
any of those variables unset the test reports itself skipped. It prints
nothing.
