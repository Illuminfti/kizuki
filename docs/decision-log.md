# Decision log

Settled product decisions. RFC 0002 is the implementation brief for D9–D16.
Gate 0 items D1–D8 were settled 2026-09-01. Autonomy items D9–D16 were
settled 2026-09-02.

| Id | Date | Decision | Answer |
| --- | --- | --- | --- |
| D1 | 2026-09-01 | Frame | Public open-source product. The owner is user one. |
| D2 | 2026-09-01 | Scope | Local-first memory substrate plus proactive rails. Not a harness. Hosts no agents. |
| D3 | 2026-09-01 | Repository | Fresh public repository. Clean history. |
| D4 | 2026-09-01 | Floors | Frozen thin ingress, subject ids from day one, fail closed, zero phone-home, deterministic floor, purge receipts, secret references, no fake surface. |
| D5 | 2026-09-01 | Agent layer | Agents are first-class clients: identity, grants, sensitivity ceilings, audit. No hosted agent loop. |
| D6 | 2026-09-01 | Run model | CLI remains usable without a daemon. D15 later installs the daemon at init. |
| D7 | 2026-09-01 | Language | TypeScript on Bun. Single workspace. |
| D8 | 2026-09-01 | Name and license | Kizuki. MIT. Free local forever. Recall is never metered. |
| D9 | 2026-09-02 | Autonomous canon | The loop writes Markdown canon. Every write is receipted, attributable, budgeted, and reversible. |
| D10 | 2026-09-02 | No owner review queue | There is no owner review queue and there never will be one. The TUI is audit and undo only. |
| D11 | 2026-09-02 | Auto-labeled sensitivity | Sensitivity is assigned automatically from connector defaults and model refinement. Unlabeled pages are never served. |
| D12 | 2026-09-02 | Model required for world model | Capture, ledger, search, timeline, context, audit, and undo work with no model. Canon writing requires a configured model. Doctor says so when it is missing. |
| D13 | 2026-09-02 | Retrieval behind a port | Derived retrieval is a versioned port. Implementations may own a store under `<vault>/.kizuki/retrieval/`. The store is rebuildable from ledger plus canon. |
| D14 | 2026-09-02 | MCP correct | Serving exposes two write tools: `propose` and `correct`. Conversational correction is the human path. |
| D15 | 2026-09-02 | Daemon at init | `kizuki init` installs `kizuki serve` as an always-on user service. The CLI still runs when the daemon is down. |
| D16 | 2026-09-02 | Modular monolith with ports | One process. Every replaceable component sits behind a versioned port, a registry, and a shared conformance suite. |
| D17 | 2026-09-04 | Retrieval permitted fork | Owner override: stop treating clean-reimplementation-only as the final word for the retrieval engine. Fork the public upstream tip (reachable default branch) of the retrieval recipe and entity graph into `@kizuki/retrieval-pg` as a permitted fork behind `kizuki.retrieval/v1`. Hybrid when embeddings exist; FTS otherwise, with declared degradation. Rerank and local GGUF remain Kizuki-own. Do not use the unreachable fork snapshot named in the D13 implementation notes. Do not invent a second product. |
| D18 | 2026-09-05 | Arbitrary-agent enrollment | Supersedes RFC 0002 §8.4's personal default. New arbitrary agents authenticate with an inert public grant: empty tools/types/subjects, rate 60, and no owner-correction relay. `OWNER` is unchanged. `OWNER_AGENT_GRANT` remains an explicit private harness preset with its former useful scope. Existing stored grants are unchanged. |

D9–D16 supersede any earlier Gate 0 answer that made the owner the only
consumer of a review queue, or that forbade scheduled canon writes.
D17 amends the D13 implementation-facts paragraph below; it does not
rewrite the 2026-09-02 D13 row.

## Rules for agents (binding)

- Read `docs/CURRENT.md`, this file and `rfcs/0002-autonomous-canon.md`
  before touching code, tests, documentation, specs or skills. Where any
  other document conflicts with them, they win.
- Never reintroduce a superseded policy anywhere, including pull-request
  text: no owner review queue, no owner approval step, no "owner promotes",
  no owner labeling of sensitivity, no zero-model canon writing, no
  owner-started daemon, no SQLite-only rule for derived retrieval.
- Code that still implements a superseded policy is a transitional state
  that a named lane removes. It is not a rule to preserve or extend.
- Do not edit the decision rows above except to record a new owner
  decision with its date. Never soften, reinterpret or "balance" an entry.
- Reviewers fail any change that reintroduces a superseded policy.

## The owner's words (2026-09-02)

The loop must write canon. Putting chores on the owner means they never get
done. The product must be as autonomous and hands-off as possible, apart
from connecting sources. When information is wrong the owner tells their
agent and it is corrected as it goes: a process of good enough. Components
must drop in, drop out, upgrade and change without breaking everything
else.

Estate evidence for D9-D10 is tabulated in RFC 0002 §1.1 (E1-E11).

## Implementation facts recorded against D13 (2026-09-02)

The owner's instruction was to adopt the upstream retrieval engine listed
in `docs/upstream-policy.md` for vector search, hybrid retrieval and the
entity graph, with QMD's local GGUF embedding and rerank stack as the
default when no endpoint is configured. Recon on the same day found: the
engine is not published on a package registry under a usable name; the
owner's earlier checkout is a fork not reachable from upstream, hundreds of
commits behind, with personal configuration committed; the engine ships no
reranker and no local model path; its embedded store allows one
connection. RFC 0002 §9.1 therefore selects a clean reimplementation of the
retrieval recipe with prominent credit and keeps a permitted fork open for
the entity graph, and §9.4 assigns the local embedding and rerank path to
Kizuki's own work using QMD's model stack. That resolution stands unless
the owner overrides it here.

## Owner amendment to D13 (2026-09-04)

The owner overrode the clean-reimplementation-only selection. D17 records
the new boundary: a permitted fork of the public tip's retrieval recipe
and entity graph into `@kizuki/retrieval-pg` (`packages/retrieval-pg/vendor/`),
pinned at public `master` `8c70f6255047a7647adb30b1d6333a48068d9fa5`
(package 0.48.2.0). The D13 facts above remain true: the engine is still
unpublished to a package registry; the unreachable snapshot must still
not be used; rerank and local GGUF remain Kizuki-own. The change is the
boundary, not those facts.

## Campaign-scope decisions (owner, 2026-09-02, round 1)

| Id | Decision | Answer |
| --- | --- | --- |
| C1 | Finish line | 1.0 as defined in `docs/wave1/plan/ROADMAP.md`: stranger proof and estate cutover, both. The 14-day parallel run starts inside the campaign. |
| C2 | Build and review | Each lane is built by an agent in its own worktree and reviewed through three lenses before merge: spec and invariants, regressions and quality, an independent model. Findings need evidence. Reviews of already-merged work land as follow-up pull requests. |
| C3 | Connectors at 1.0 | Full list: Telegram user sign-in, Gmail and Google Calendar, IMAP and ICS, WHOOP, X (archive import plus paid API sync funded by the owner), screenpipe, markdown folder, importers for ChatGPT, Claude, X archive, WhatsApp export, Pocket, Omnivore. Deferred with stated limits: Composio, WhatsApp Business API. |
| C4 | Sign-in, not setup | The project registers and ships its own app credentials, compiled in at build time from environment variables; source constants are placeholders that make sign-in refuse with an exact message; the owner fills a credential file outside the repository. |
| C5 | Merge and release authority | The owner's delegated maintainer merges every pull request that carries review evidence and green CI, tags releases and publishes packages. Merge commits use custom subjects so the repository owner's login never enters a reachable commit message. |
| C6 | Model provider | Generic OpenAI-compatible chat completions over plain fetch, configured by `base_url`, `model` and a `secret_ref`; no vendor SDK. |
| C7 | Estate parallel run | Shadow mode: days 1-7 the owner's assistant asks both stacks and answers from the estate with diffs logged; stop and report at day 7 before any flip; estate units stay up; nothing archived until the owner reads the parity log. |
| C8 | 1.0 moat | Autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness. The owner review gate is no longer a claim anywhere. |

## Text that still carries the old policy (to annotate, never to follow)

`docs/wave1/plan/*` and `docs/wave1/plan/oracle-review.md` are historical
records under a supersession banner, with inline notes on the rows and
headings that state a superseded policy as current. `docs/CURRENT.md` names
the Wave 1 specs that are void as written; each of those, and every other
spec that carried a superseded policy, opens with a "Decision-log deltas
(2026-09-02)" section. Skills under `.agents/skills`, their `.claude/skills`
adapters, the scoped `AGENTS.md` files, `packages/connector-screenpipe/README.md`,
`docs/lifeos-capability-gap.md`, `docs/upstream-policy.md` and
`.maestro/tasks/tasks.jsonl` were aligned on 2026-09-02. Where any of them
still quotes the old policy, it is quoted under a banner or an inline
supersession note; the rules above govern regardless.
