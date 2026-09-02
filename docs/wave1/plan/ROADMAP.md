# Kizuki — roadmap, waves, gates

Waves are internal build phases; public claims lag reality (no public link
until the demo loop runs — carried floor). 1.0 requires BOTH proofs: a
stranger succeeds on a fresh machine, and the owner's estate is cut over
(decision 13). Every gate: proof = a command someone else can run.

## Gate 0 — plan approval (now)

the owner approves this plan set. Then immediately: claim `kizuki` on npm + PyPI
(honest placeholders; needs registry tokens), create `the ownernfti/kizuki`, MIT
LICENSE + free-local-forever pledge in README from commit one, CI skeleton
with all gates live, GPT Pro constraint brief sent, Maestro Wave-1 batch.

## Wave 1 — spine (the stranger loop, files only)

Contracts (`kizuki.event/v1`, `kizuki.proposal/v1`), ledger + queue semantics

- purge receipts, vault init + frontmatter validation, deterministic staging
  producers, `kizuki review` TUI, promote + receipts, `doctor`, markdown-folder
  connector + ChatGPT/Claude export importers.
  **Exit proof:** scripted e2e in CI — init → import → review → promote → query,
  zero LLM key, on a fresh machine; lessons-as-tests all green.

## Wave 2 — serving (agents become first-class)

MCP server (stdio) with read tools + `propose`, agent identity/grants/audit,
FTS query surface, `context` packets, response envelope with provenance
separation.
**Exit proof:** Claude Code and the personal harness both wired to a test vault via MCP;
grant-ceiling test (private page never served to a `personal`-ceiling agent);
audit log renders. the owner starts daily-driving a personal vault here.

## Wave 3 — connector waves (all real, conformance-gated)

- 3a: IMAP email, ICS + Google Calendar, Pocket/Omnivore importers.
- 3b: Telegram (Bot API + export), Gmail API, X.
- 3c: WhatsApp (export, then Business API), WHOOP, Screenpipe adapter,
  Composio meta-connector.
  **Exit proof per connector:** conformance suite green (fixture round-trip,
  fail-closed, idempotent double-backfill, tombstones, purge plan, resume).
  No wave ships a stub — the registry only ever lists what passes.

## Wave 4 — proactive rails

`kizuki serve` daemon: scheduler + run receipts, connector sync loops, daily
brief artifact, Telegram/email/webhook notifiers, doctor staleness reporting,
standing loopback MCP with per-agent tokens.
**Exit proof:** 7 consecutive days of receipts on a live vault with zero
missed rails; brief lands each morning; kill-and-restart resumes cleanly.

## Wave 5 — hardening + public visibility

SECURITY.md complete + disclosure channel, GPT Pro RFC absorption (identity /
reduction / review packets — as merged RFCs only), embeddings option, export
command, packaging polish (brew tap, install script, compiled targets).
**Exit proof (first public link):** demo loop recorded end-to-end; a
non-author on a fresh machine reaches promoted canon + agent query in ≤ 15
minutes with zero help. This is the earliest any announcement happens.

## Wave 6 — estate migration ([MIGRATION.md](MIGRATION.md))

Importer + parallel run + the personal harness re-point + cutover.
**Exit proof:** estate LifeOS rails retired (archived, never deleted); the personal harness
answering from Kizuki MCP; lossy-mapping report reviewed; 14-day parallel-run
receipt parity.

## → 1.0 tag

Both proofs on record (Wave 5 stranger proof + Wave 6 cutover proof), full
connector list live, GO/NO-GO script green. The README claims exactly what
exists on the day of the tag.

## Standing merge gates (every PR, every wave)

Small branch, readable diff, tests included, CI green (typecheck, matrix,
gitleaks, denylist, zero-phone-home, compile smoke). Lessons-as-tests only
ratchet up. Contract/privacy/security/release PRs: the owner merges.
Mechanical/test-only: Fable may merge. Workers never merge.
