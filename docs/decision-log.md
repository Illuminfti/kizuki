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
| D19 | 2026-09-05 | Readiness without calendar gates | Owner amendment in issue #403: ready means a stranger can install and use Kizuki, with executable stranger proof, zero live P0s on the exact candidate and an honest install path. Supersedes C1's estate-cutover prerequisite and mandatory seven-/fourteen-day elapsed release gates. Long observation is optional post-ready; operational cutover requires separate authorization. Other product acceptance requirements remain. |
| D20 | 2026-09-17 | Optional System One admission | TypeSafe Jev is an optional `kizuki.systemone/v1` port, not an LLM. Unconfigured vaults keep ordinary OpenAI-compatible extraction. When `[ports.systemone]` selects `kizuki.systemone.jev`, extracted drafts are admitted by typed noul questions before claims become live. Jev never writes canon, never replaces extraction, and never generates claims JSON. A configured but dead judge is unavailable, not an empty keep. |
| D21 | 2026-09-17 | World model is the launch product | Owner amendment: 1.0 is the world model, not capture-to-context. Same-day follow-up: the entire #497 execution map is day-one 1.0. D19 still applies (stranger install, executable stranger proof, zero live P0s, honest install path). Ready requires the public seams named by #497: foundation and first Concept (#481 to #484, #503), domain expansion (#485 to #488, #494), two-client continuity and World Slice/Diff (#502, #489, #490), outcomes and attention (#491, #492), Atlas (#495), forecasts (#493), and continuous verification (#496), with #458 onboarding. The golden acceptance journey in #497 is the day-one proof. RFC 0003 and RFC 0004 remain proposed until those public seams exist. Closed GitHub packets, RFC fixtures, and planning documents are not shipped surfaces. A closed packet without a public CLI, MCP, or local-app seam does not satisfy this decision. Atlas, forecasts, ontology, and later packets in that map are not deferred past 1.0. |
| D22 | 2026-09-18 | World model built and landed on main now | Owner instruction: "get the world model stuff working on the main branch". Resolves the open calls that gated implementation: (a) RFC 0003 is **Accepted** for the B1b–B1d scope (claim-v2 semantics and support tables with migration, one shared prepare/commit writer, discriminated v1/v2 reader, backup/restore/rebuild coverage); (b) RFC 0004 is **Accepted as a minimal slice**: `DurableObservation`, the world-vocabulary registry, `ConceptCard`, a minimal `SituationCard`, and `readWorldView` with the `concept` and `situation` operations; the rest of RFC 0004 stays Proposed; (c) the D21 bar is met in order: the golden journey first (consented source → Concept or Situation context → a second authorized client resumes it → one owner correction visible to both), landed on main, then the remaining #497 packets continue on the same contracts, with recorded reasons for anything not yet shipped; (d) the public seam is a new `world_view` read tool on MCP and loopback HTTP plus `kizuki world`, taking the tool surface from nine to ten, with a revision-pinned, non-authority-carrying resume handle that clips to the resuming principal's grant and reports the clipping in coverage; (e) `OWNER_AGENT_GRANT` gains `correct`; (f) the second client learns of corrections by polling (pull-only lifecycle) in 1.0; (g) the storage ports in `contracts/storage.ts` stay out of 1.0 scope; (h) `rfcs/0004-world-storage.md` is Appendix A to RFC 0004, not a second RFC 0004. Fable merges each lane PR after two-axis review evidence and green required checks. |
| D23 | 2026-09-23 | Public 1.0.0 release today | Owner steer: release 1.0.0 publicly today. The launch bar is the world model as built on the 2026-09-21 launch stack (typed extraction, Concepts and Situations, `kizuki world`, MCP and loopback HTTP `world_view`, the app World views and world-claim correction) and Telegram native sign-in. Evidence gates are no longer release prerequisites: stranger proof, live-account qualification, independent-review receipts, seven- and fourteen-day observation, and go/no-go or release-acceptance reports. The remaining release gates are a clean typecheck, a green test suite, the release build and release smoke, and a hands-on run of the world model and Telegram from the built package. D19 and D21 readiness text is superseded where it conflicts. |

D9–D16 supersede any earlier Gate 0 answer that made the owner the only
consumer of a review queue, or that forbade scheduled canon writes.
D17 amends the D13 implementation-facts paragraph below; it does not
rewrite the 2026-09-02 D13 row. D23 supersedes the D19 and D21 readiness
bars where they conflict; it does not rewrite those rows.

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

Historical answers are retained below. D19 supersedes C1's estate-cutover
prerequisite and any use of C7's observation schedule as a readiness gate.
C7 records the earlier operational plan; it does not authorize a cutover.
C2–C6 and C8 are unchanged by the readiness amendment.

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

## Owner amendment to readiness (2026-09-05)

D19 records the explicit supersession at the top of
issue #403. A stranger must be able
to install Kizuki, connect a source and get value. Executable stranger proof,
zero live P0s on the exact candidate and truthful installation claims define
the readiness bar; this entry does not assert that the evidence exists.

Seven-day rail observation and fourteen-day estate comparison remain optional
post-ready diagnostics. They are not elapsed-time requirements for readiness
or a 1.0 tag. Retain actual timestamps, interruptions and limitations in all
historical receipts; this amendment grants no observation credit. Operational
cutover is a separate, explicitly authorized action, including any change to
existing estate services or archival of their data.

The amendment removes calendar and cutover prerequisites only. It preserves
the mandatory connector inventory and its honest limits, security and
capability checks, Linux/macOS coverage, compiled checksummed artifacts tested
outside the checkout, backup/restore, purge and undo proofs, and exact-head
review and verification. Existing runtime health rules and receipt windows
remain in force. It does not relax frozen ingress, canon authority, grants,
sensitivity, provenance, correction or recovery semantics.

## Owner amendment: world model is the launch product (2026-09-17)

D21 records the owner's instruction that 1.0 is the world model, not
capture-to-context. D19 still defines how readiness is proved. D21 defines
what product must be proved.

A stranger must be able to install Kizuki, connect a consented source, and
have a second authorized client resume current Concept or Situation context
without reconstructing history. One owner correction must be visible to both
clients. That journey remains the first public proof. Capture, search,
context packets, and receipted canon remain the substrate; they are not the
launch product.

The same-day owner follow-up makes the entire #497 execution map day-one
1.0. Ready requires the public seams named by that map: foundation and first
Concept (#481 to #484, #503), domain expansion (#485 to #488, #494),
two-client continuity and World Slice/Diff (#502, #489, #490), outcomes and
attention (#491, #492), Atlas (#495), forecasts (#493), and continuous
verification (#496), with #458 onboarding. The golden acceptance journey in
#497 is the day-one proof. Atlas, forecasts, ontology, and later packets in
that map are not deferred past 1.0.

RFC 0003 and RFC 0004 stay proposed until those public seams exist on the
exact candidate. Closed GitHub packets, RFC fixtures, and planning documents
are not shipped surfaces. Issue #497 remains the execution map. A closed
packet that never exposed a public CLI, MCP, or local-app seam does not
satisfy this decision.

This amendment does not create a second canon writer, an owner review queue,
or a fake public surface. It does not relax D19, connector honesty, security,
recovery, platform, review, or verification requirements.

## Owner amendment: public 1.0.0 release (2026-09-23)

D23 records the owner's steer to publish 1.0.0 the same day. Telegram has to
work and the world model has to work; the other evidence is not a release
prerequisite. Where D19 or D21 names stranger proof, zero-P0 evidence on the
exact candidate, the full #497 map, live-account qualification, review
receipts or observation windows as conditions for a 1.0 tag, D23 replaces
those conditions with the gates listed in its row. The #497 packets that are
not in 1.0.0 remain the roadmap; they are not claimed as shipped.

D23 relaxes release evidence only. It does not relax frozen ingress, canon
authority, grants, sensitivity, provenance, correction, recovery, zero
phone-home or the no-fake-surface rule, and it does not authorize any
operational cutover of existing services.

## Implementation facts recorded against D23 (2026-09-23)

- Canon-write recovery is bound to the write intent. Each staged file is
  classified against the intent's images: an exact or prefix stage is
  removed, a foreign stage of an ordinary write is moved to
  `.kizuki/quarantine/canon-stage/` rather than deleted (withdrawal, purge
  and erasure remove it, since they exist to erase), and an unsafe stage is
  left untouched and holds recovery. Every action is recorded as planned
  before it happens; records name no page path or content hash.
- A held recovery no longer stops the daemon. `kizuki serve` logs the hold,
  keeps the other rails running, stops only the write pass, and records the
  last attempt in `.kizuki/canon-recovery-hold.json`. `doctor` and `recover`
  name the typed reason and the next step.
- A startup refusal that repeats on every start (unsupported platform, not
  supervised, root user, vault mismatch, or a ledger that needs
  `kizuki init` to migrate) exits 78, and the user unit does not restart on
  that status. A custody check that can be transient exits 1 instead. The
  unit carries a start limit and `MemorySwapMax=0`, and doctor names the
  command that follows from the unit's last result.
- A pending canon write made before ledger migration 32 still completes after
  it: the claim guard accepts the same row when only the new
  `is_world_typed` column differs and holds its default.
- A file-level copy or restore of a vault with a pending write refuses with
  `receipt_stream_changed` and changes nothing. Rebinding a relocated vault
  is not implemented.

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
