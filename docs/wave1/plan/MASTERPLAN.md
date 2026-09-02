# Kizuki — master plan

> **Superseded in part on 2026-09-02.** `docs/CURRENT.md`, `docs/decision-log.md`
> and `rfcs/0002-autonomous-canon.md` are binding: autonomous canon with no
> owner review gate, auto-labeled sensitivity, a configured model required for
> the world model, retrieval behind a port, an MCP `correct` tool, an always-on
> daemon installed at init, and a modular monolith with pluggable ports. This
> document is a historical record; where it conflicts, the binding documents win.

気づき — "awareness; the moment of realization."

**Your life, queryable as a CLI and MCP.** Open-source, local-first: your
digital life captured into a durable queue, distilled into staged proposals,
**reviewed and promoted by you** into a canonical Markdown world model you own,
served to any agent from any harness — the personal harness, Claude Code, codex, anything —
as first-class citizens with identity, scoped permissions, and audit. Kizuki is
not a harness and hosts no agents; it is the memory substrate every harness
pairs with. Ground-up rebuild of LifeOS; the private estate migrates onto it
and retires.

Planned 2026-09-01 by Fable with the owner across four grilling rounds (decision
log below), a 13-agent estate grill, and a 5-agent competitive sweep of ~40
products ([COMPETITION.md](COMPETITION.md)). Supersedes
`../lifeos-oss-rebuild/decision-map/` (kept as evidence).

## Destination

A stranger installs one binary. `kizuki` works immediately in the terminal:
connect a source, capture, review a staged digest, promote what they accept
into a Markdown canon on their own disk, query it over CLI and MCP — all
deterministic with no LLM key. `kizuki serve` turns on the always-on part:
sync schedulers, daily briefs, notifiers, the standing MCP endpoint their
agents connect to. Zero phone-home, ever, CI-enforced.
**1.0 ships only when both proofs exist: a stranger succeeds on a fresh
machine, and the owner's estate LifeOS is retired with Kizuki running his life.**

## Why it wins (competitive verdict)

Across ~40 surveyed products, **the review gate — system drafts, owner
ratifies — exists nowhere.** Capture products stop at raw archives
(screenpipe, ActivityWatch); canon products can't capture (Obsidian,
SilverBullet); agent-memory products auto-extract into stores the owner never
reviews (mem0, Zep, platform memory). Kizuki is the only design connecting all
three, and its other unoccupied claims are verifiable zero-phone-home,
enforced sensitivity gating free, deterministic floor + MCP, and exit-proof
markdown canon. Main kill threats: screenpipe or supermemory adding a review
layer; an Obsidian plugin eating the wedge; solo-maintainer death. Full
analysis with citations: [COMPETITION.md](COMPETITION.md).

## Decision log (all settled with the owner, 2026-09-01)

| #   | Decision          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Frame             | Public OSS product; the owner is user #1                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Scope             | Memory substrate + proactive rails. **Not a harness, hosts no agents** (the owner's mid-plan correction, supersedes the earlier full-OS answer): pairs with any harness — the personal harness, Claude Code, codex, Grok bots — via CLI + MCP                                                                                                                                                                                                                                                      |
| 3   | Repo              | Fresh `the ownernfti/kizuki`, clean history; salvage from lifeos-oss spine by copy only                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | Floors            | All 9 standing calls + 19 evidence-settled positions carried (adapted to TS): no fake connectors, no public link pre-demo, owner-only promote, frozen thin ingress, subject ids day one, data preserved from declared floor, MCP fail-closed + capture = attacker-controlled, zero phone-home CI-enforced, upstream-first cutover; laundering gate, lessons-as-tests, purge receipts, secret_ref, deterministic floor, scripted releases, validated ontology + x- namespace, etc. |
| 5   | Agent layer       | Agents are **first-class consumers**: per-agent identity, scoped read permissions with sensitivity ceilings, propose-only writes into staging, bounded context packets, full audit trail. No agent loop, no personas, no hosting — every harness brings its own                                                                                                                                                                                                                   |
| 6   | Run model         | Program-first; `kizuki serve` starts the always-on part                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | Language          | TypeScript on Bun; single compiled binary + npm dist                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | Name              | **Kizuki** — binary `kizuki`, repo `the ownernfti/kizuki`; npm + PyPI `kizuki` free (checked 2026-09-01), claim on plan approval                                                                                                                                                                                                                                                                                                                                                     |
| 9   | Daily surface     | CLI/TUI-first at 1.0; no web dashboard; notifier digests point at `kizuki review`                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | Connectors at 1.0 | Full estate list live: Telegram, WhatsApp (Business + export), Gmail, IMAP, Google Calendar, WHOOP, X, Screenpipe adapter, Composio, markdown-folder — plus graveyard importers (ChatGPT/Claude/Pocket/Omnivore exports). No stubs ever                                                                                                                                                                                                                                           |
| 11  | the personal harness            | Separate forever; consumes Kizuki via MCP like every other harness. Estate migration = memory layers, not the persona stack                                                                                                                                                                                                                                                                                                                                                       |
| 12  | License           | MIT + free-local-forever pledge in README from day one; recall never metered; any hosted convenience lives in separate opt-in packages                                                                                                                                                                                                                                                                                                                                            |
| 13  | 1.0 bar           | Stranger loop AND the owner cutover, both                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | GPT Pro           | Continues as constrained designer: receives the written brief (TS/Bun, SQLite, markdown canon, frozen ingress, subject ids, receipts), delivers RFCs that bind only when merged; Fable arbitrates                                                                                                                                                                                                                                                                                 |
| 15  | Build start       | On the owner's approval of this plan: claim names, scaffold repo, open Wave 1 lanes                                                                                                                                                                                                                                                                                                                                                                                                  |
| 16  | Sign-in, not setup (2026-09-01, the owner) | Connecting a source is `kizuki connect <service>` → sign in → done. No developer console, no keys pasted, no export files as the primary path. The project registers and ships its own app credentials (Telegram app id/hash, Google installed-app OAuth client, X OAuth client) the way open-source clients do; owner tokens and sessions live only on the owner's disk as `file:` secret_refs. Where a service offers no sanctioned user sign-in (WhatsApp), the honest paths are export import and the Business API, stated as such. Connector contract carries `auth_modes` + optional `signIn`; conformance checks the two agree. |

## Operating model

- **the owner** — owner. Approves this plan (= Gate 0), merges anything touching
  contracts, privacy, purge, security, release tags. Daily user from Wave 1.
- **Fable** — architect + review bar. Owns this plan, the GPT Pro brief and
  arbitration, TUI/taste work hands-on, PR review before the owner. May merge
  mechanical/test-only PRs.
- **GPT Pro (Oracle)** — deep-architecture designer under written constraints;
  RFC PRs only; also red-teams SECURITY.md.
- **Coordinator (Maestro)** — wave tasks with blockedBy edges mirroring
  [ROADMAP.md](ROADMAP.md); created only for decided waves.
- **Cloud agents** — codex-primary lanes; one task, one small branch, red-green
  proof; never merge; never see private estate paths (synthetic fixtures only).
- **GitHub** — everything reviewable: ordinary files, small branches, tests,
  citations on research, CI (typecheck + tests + gitleaks + zero-phone-home
  - estate-identifier denylist). No opaque archive/materialization commits.

## The plan set

- [ARCHITECTURE.md](ARCHITECTURE.md) — full technical design, layer by layer
- [ROADMAP.md](ROADMAP.md) — waves, gates, proofs
- [MIGRATION.md](MIGRATION.md) — estate → Kizuki, laundering airlock, cutover
- [COMPETITION.md](COMPETITION.md) — landscape, threats, design implications

## Immediate actions on approval (Gate 0 close)

1. Claim `kizuki` on npm + PyPI (honest placeholder) and create
   `the ownernfti/kizuki` (needs registry account tokens on the box — flagged).
2. Scaffold repo: Bun workspace, strict TS, CI skeleton with all four gates.
3. GPT Pro constraint brief sent.
4. Maestro Wave-1 batch created; codex lanes open on the spine.
