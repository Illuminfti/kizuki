# `@kizuki/connector-telegram`

## What it reads

This package signs in as you and reads your own Telegram dialogs: private
chats, groups, and the channels you follow. It is not a bot. It never posts,
and it never removes anything at the source.

Every non-service message becomes one `message` event, and every one of them
is labeled `private`. Messaging is a private source class, a label may only
be raised from where the source puts it, and a channel you follow is no
exception: the posts may be published, but which channels you read is not.
Subjects are the sender, the other party, and the chat itself, so a later
purge can be aimed at one correspondent.

This is the only package in the repository with a runtime dependency. It uses
`telegram` (GramJS) to speak MTProto, and the library is loaded lazily inside
the client factory, so nothing in the registry, the offline fixture or the
conformance suite pulls transport code into the process.

## App credentials

Telegram issues an app id and hash once per project, not once per person. You
are never asked to paste one. The two values are inlined when the binary is
built:

```sh
KIZUKI_TELEGRAM_API_ID=… KIZUKI_TELEGRAM_API_HASH=… \
  bun build packages/cli/src/main.ts --compile --env 'KIZUKI_TELEGRAM_*' \
  --outfile kizuki
```

A build without them refuses to sign in, with this message and nothing else:

```
kizuki.telegram: app credentials are not compiled in; build with KIZUKI_TELEGRAM_API_ID and KIZUKI_TELEGRAM_API_HASH set (see packages/connector-telegram/README.md)
```

There is no fallback and no prompt. During development, export the same two
variables in your shell before running from source. Keep the registered pair
out of the repository: Telegram penalises published credentials with
`API_ID_PUBLISHED_FLOOD` for everyone using that build.

## Signing in

Sign-in asks for three things at most, in this order:

1. your phone number in international format, for example `+15551234567`;
2. the code Telegram sends you;
3. your two-step verification password, if the account has one. The prompt is
   masked, and any hint Telegram supplies is shown once and never stored.

You get two more tries after a wrong code or password, and the prompt says
which of the two Telegram refused. The third rejection abandons sign-in and
writes nothing. Only a credential Telegram named as wrong counts against those
tries: a wait or a connection fault ends the attempt with its own reason
instead of being spent as one of them, and an entry with nothing in it is
asked again rather than sent, on a budget of its own that ends sign-in after
three. A code is sent as its digits alone, so a pasted one carrying a space
still works; a password is sent exactly as typed, padding included. A short wait passes quietly and sign-in
continues; a longer one is reported to you with the number of seconds, because
a silent multi-minute pause looks like a hang.

A number no Telegram account exists for is refused. The library this package
uses would otherwise register one under a placeholder name and accept
Telegram's terms of service on your behalf; both are outbound actions, and
this connector takes none.

The terminal verb that drives this flow is not part of this package. On this
revision `kizuki connect` enrolls `none`-mode sources only, so
`kizuki connect telegram --source …` answers
`sign-in for kizuki.telegram is not wired yet`. Until that lands, the sign-in
above is reachable from library callers through `enrollConnection` in
`@kizuki/core`.

## Where the session lives

Sign-in produces one opaque blob holding your account id and the session
string. Core, not this connector, chooses the filename and writes it to
`<vault>/.kizuki/connections/<source key>.state` with mode `0600` inside a
`0700` directory. The database records only the reference
`file:connections/<source key>.state`. The session bytes never reach SQLite, a
log line, an error message, a cursor, or event metadata. Telegram writes the
text of the failures it sends, so none of it is repeated either: an error from
this package says what this package concluded, with a redacted cause, and
never quotes the reply it read.

Re-authenticating replaces that file in place and keeps the same source key,
so checkpoints survive. Connecting with a session that belongs to a different
account is refused rather than quietly re-pointed.

Revoking ends the session at Telegram itself, and it is final for the
connector that did it: the client is let go and every later read, sync or
reconnect on that instance is refused, whether or not the socket closed
cleanly. A connector with nothing live to end
refuses to revoke rather than report an access that never stopped. Removing
the state file and marking the row are the host's part.

## What it does not do

Deletions are invisible to it. Telegram publishes them on the update stream,
which this connector does not consume, so the manifest declares
`tombstones: false` and a message you delete in Telegram stays in your ledger
until you purge it.

Edits are caught within a window. Each pass re-reads the last 200 messages of
a dialog before it reads anything newer, and re-emits whatever changed since
the previous completed pass. Reading the window first is what makes it whole:
a dialog whose work does not fit stops the pass on itself, and because nothing
has moved on yet, the next batch re-reads the same window rather than one
shifted past it. The watermark a completed pass leaves behind is the moment
that pass began, never the moment it ended, so an edit made to an
already-read dialog while the rest of the account was still being read is
still found afterwards. An edit to something older than 200 messages is
missed.

Service messages are skipped: joins, pins and title changes carry no content
worth keeping. So is a message whose timestamp is not a date the ledger
accepts, which is the one record a corrupt page can cost you.

Attachments are recorded by id, media type, filename and size. No file is ever
downloaded.

A run lists at most 5000 dialogs. Reaching that bound sets health to degraded
and names the limit, so a truncated view is visible rather than silent. A
dialog that drops out of the listing is skipped rather than written off: its
entry keeps the id it reached and the backfill stays unfinished, so a chat
that comes back resumes instead of starting again. At the bound, the resume
cursor may drop such a peer to stay within the same 5000, finished ones first.

Waits are obeyed. When Telegram asks for a pause, a pass that had already
covered ground ends early with a cursor describing exactly the events it
returned and the history it read past. That holds even when the pages it read
carried nothing worth keeping — service messages, or dates the ledger refuses
— because a dialog that opens with thousands of them would otherwise never be
got past. A pause that leaves nothing to hand back at all, or nothing a cursor
can resume from, is reported to the caller as the wait it is. Either way health
reports how many seconds are left, and no further request is made until the
pause has lapsed.

Secret chats cannot be read. They are end-to-end encrypted per device, and
the library this connector uses implements no part of that protocol: the
`telegram` package ships no secret-chat client at all.

## Purge

`purgeSource` returns a plan, not a deletion. Telegram keeps its own copy and
this connector performs no outbound actions, so every record it can name for a
subject is listed under `unreachable_source_record_ids` and
`source_record_ids` is empty. The plan covers what this process emitted, up to
10 000 records per subject; the ledger's own purge is keyed on the subject, so
a truncated plan still removes everything Kizuki holds.

## Tests

Everything runs against a scripted in-memory account with no network. The
module that talks to Telegram is driven against a stand-in for the library, so
its error handling and its record mapping are covered cold. The one test that
reaches Telegram itself is skipped by default and never runs in CI. To run it
by hand:

```sh
KIZUKI_TELEGRAM_SMOKE=1 KIZUKI_TELEGRAM_API_ID=… KIZUKI_TELEGRAM_API_HASH=… \
  KIZUKI_TELEGRAM_SMOKE_PHONE=+15551234567 \
  bun test packages/connector-telegram/test/client.smoke.test.ts
```

It signs in interactively and lists one dialog.

## Provider facts

Checked 2026-09-02 against `core.telegram.org/api/auth` and
`core.telegram.org/api/obtaining_api_id`. A person signs in with
`auth.sendCode`, then `auth.signIn` with the code, and `auth.checkPassword`
when two-step verification returns `SESSION_PASSWORD_NEEDED`. The app id and
hash are registered once per application and belong to whoever ships the
build. Authentication rules and quotas change; re-check before relying on any
of this.
