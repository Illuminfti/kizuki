# Security

Kizuki stores one person's life on their disk. The threat model is
**host-trust interim**: the vault, ledger, and canon are readable to anyone
who can read the owner's files. A versioned encryption seam is reserved in
the ledger; it is not a claim that pages are encrypted today.

## Invariants that are load-bearing

1. **No phone-home.** Runtime network access is limited to user-configured
   connectors and the user-configured model endpoint. CI fails on any
   network surface outside `scripts/network-allowlist.txt`.
2. **Fail closed.** Missing sensitivity → not served. Missing credentials →
   the connector refuses. Unknown agent → no access.
3. **Captured text is data, never instruction.** Extraction runs with no
   tools. Canon pages carry `taint`. Serving keeps canon prose and quoted
   capture in separate fields.
4. **Owner correction outranks every other authority tier.** `tell` /
   `correct` supersede the contradicted claim and rewrite affected canon in
   the same pass.
5. **Capture never writes canon.** Only `applyCanonWrite` does. Every write
   is receipted and reversible by `kizuki undo <receipt>`.
6. **Secrets stay behind `env:` and `file:` references.** Never persist
   plaintext credentials in SQLite, logs, fixtures, snapshots, or Markdown.
7. **Purge is physical deletion with a receipt.** `kizuki purge --verify`
   prints an absence proof per store.

See [docs/architecture.md](docs/architecture.md) for the full invariant list.

## Sign-in enrollment on this revision

The CLI enrolls native sign-in for IMAP, Telegram, Gmail, and Google Calendar.
IMAP uses an interactive local prompt and an app password. Telegram uses
native phone/code sign-in with optional two-step verification. Gmail and
Google Calendar use operator-configured desktop OAuth clients and a system
browser. Other account connectors, including WHOOP and the X API package
subpath, are not enrollable through this CLI.

Operator credentials are required and fail closed:

- Telegram needs project `api_id` and `api_hash`
  (`KIZUKI_TELEGRAM_API_ID` / `KIZUKI_TELEGRAM_API_HASH`). From source, export
  them. The current native release build inlines `KIZUKI_COMPILED` only and
  does not compile those Telegram values; a binary that includes them is a
  separate build.
- Gmail and Google Calendar need operator desktop client IDs
  (`KIZUKI_GMAIL_CLIENT_ID`, `KIZUKI_GOOGLE_CALENDAR_CLIENT_ID`) and optional
  `env:` / `file:` secret references. This tree does not register a Google
  application.
- Missing credentials refuse before prompts, browser launch, or provider
  calls.

Mailbox passwords, OAuth tokens, and Telegram sessions stay in owner-only
connection-state files or behind `env:` / `file:` references. They are not
written to SQLite, logs, fixtures, snapshots, or Markdown. None of these
sign-in paths have live-account or copied-artifact qualification on this
revision; synthetic tests are not that proof.

Telegram API Terms restrict use of Telegram data for AI and ML. Owner/legal
disposition is required before native live qualification. Login-code delivery
for a given Telegram account is unknown until an authorized trial; this page
does not claim that third-party sign-in is universally prohibited.

## What this revision does not claim

- Disk encryption of the vault or canon.
- A packaged binary or signed installer.
- Live-account, copied-artifact, or unfamiliar-user qualification of any
  connector.
- CLI enrollment of WHOOP, the X API package, Composio, or WhatsApp Business
  API.
- Remote multi-tenant isolation. One vault is one owner's machine.

## Reporting

Open a private vulnerability report on the repository's security advisory
surface. Do not file a public issue that includes captured personal text,
tokens, vault paths, or a working exploit.

Do not include owner names, wallets, or estate identifiers in a report body
that will be copied into the tree.
