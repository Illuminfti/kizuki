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

## What this revision does not claim

- Disk encryption of the vault or canon.
- A packaged binary or signed installer.
- Sign-in connector enrollment through this CLI (Telegram, IMAP packages
  exist; the CLI will not enroll them).
- Remote multi-tenant isolation. One vault is one owner's machine.

## Reporting

Open a private vulnerability report on the repository's security advisory
surface. Do not file a public issue that includes captured personal text,
tokens, vault paths, or a working exploit.

Do not include owner names, wallets, or estate identifiers in a report body
that will be copied into the tree.
