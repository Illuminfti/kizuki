# Kizuki — competitive landscape

> **Superseded in part on 2026-09-02.** `docs/CURRENT.md`, `docs/decision-log.md`
> and `rfcs/0002-autonomous-canon.md` are binding: autonomous canon with no
> owner review gate, auto-labeled sensitivity, a configured model required for
> the world model, retrieval behind a port, an MCP `correct` tool, an always-on
> daemon installed at init, and a modular monolith with pluggable ports. This
> document is a historical record; where it conflicts, the binding documents win.

Research run 2026-09-01: 5 agents, ~40 products, primary sources (repos, docs, pricing, changelogs). Survey feeding the positioning in [MASTERPLAN.md](MASTERPLAN.md).

## Positioning

Kokoro sits at the empty intersection of three crowded columns. Column one, capture: screenpipe (21.4k stars, YC-funded, weekly releases), ActivityWatch (18.8k stars, a decade of watcher/bucket capture), Beeper's mautrix bridges, and $50-89 wearables (Bee/Omi) prove passive multi-source capture has durable demand — but every one of them stops at a raw searchable archive with no distillation, which their own communities name as the chief complaint. Column two, canon: Obsidian's ecosystem, SilverBullet, Foam, Basic Memory, and even Anthropic's official file-directory memory tool and Letta's git-versioned Context Repositories have converged on the same answer — plaintext files the owner can read, diff, and version beat databases (Logseq's DB rewrite and Anytype's object store both paid in community trust) — but none of them has a capture pipeline, so the canon only knows what you typed. Column three, agent memory: mem0 ($24M), supermemory (~$29M), Zep, cognee, and platform memory (ChatGPT Dreaming, Claude memory) made MCP the standard agent surface and 'give your agents context' the demand pull — but all of them are silent auto-extraction into stores the owner never reviews, and the press verdict on the category leader is literally 'quietly rewrites its memories of you… unsettling.' Kokoro is the only system in ~40 products surveyed that connects all three: passive capture into a durable local queue, LLM-optional staged proposals, an OWNER-review promotion gate into markdown canon on the owner's disk, and read-only MCP with enforced sensitivity gating, zero phone-home. Superseded 2026-09-02, see `docs/decision-log.md` C8 and D10: the owner review gate is no longer a claim anywhere; the restated moat is autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness. Two honest caveats: the lane is empty partly because it monetizes modestly (Basic Memory, the nearest occupant, is indie-scale at $15/mo — this is a Readwise/Reflect-style niche-profitable position, not a venture position), and its addressable audience is the burned-refugee cohort (Pocket/Omnivore/Rewind/Limitless funerals) plus agent power-users, not the mass market the platforms already serve for free.

## Whitespace (unoccupied claims)

Superseded in part 2026-09-02, see `docs/decision-log.md` C8: the first claim below is withdrawn. The remaining claims — verifiable zero-phone-home, enforced sensitivity gating free, provenance-stamped plaintext canon — stand, joined by autonomy with total provenance, reversibility by receipt, and conversational correction (RFC 0002 §1.3).

- The review gate itself: capture → staged proposal → owner approval → promoted canon exists NOWHERE across all four sweeps or gap-check searches. Superseded 2026-09-02, see `docs/decision-log.md` C8 and D10: the owner review gate is no longer a claim anywhere; the restated moat is autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness. Competitors split into auto-magic piles (Fabric, Mem 1.0, Bee's hallucinated to-dos, ChatGPT Dreaming) and manual-ontology labor (Capacities, Tana); 'system drafts, owner ratifies' is an empty quadrant and every funded competitor's roadmap moves AWAY from human review because their metric is recall, not trust.
- Enforced sensitivity gating on a personal/free tier: only screenpipe ships declarative per-agent data permissions enforced below the prompt layer, and only at $150/seat enterprise. Nobody offers it free and personal; unreviewed MCP WRITE access (Basic Memory, Anytype, Claude memory tool str_replace) demonstrably pollutes graphs, making read-only + gating a legible differentiator.
- Verifiable zero-phone-home: the claim is unoccupied because competitors keep fumbling it — screenpipe ships default PostHog/Sentry telemetry inside a 'local-first' app, Omi brands MIT-open-source while routing audio through Deepgram+Firebase, Rewind stored locally but had a cloud kill switch Meta flipped remotely. No product in the category can pass a network-egress audit; communities audit and remember.
- Deterministic floor combined with an agent surface: SilverBullet, ActivityWatch, HPI/Dogsheep, and Dendron proved LLM-free value (queries, schemas, typed events), and Karakeep proved Ollama-optional AI, but nobody combines deterministic capture+canon with MCP. Every agent-memory player (mem0, cognee, Zep, Honcho) requires an LLM key just to ingest — a cost that scales with your life, not your questions (Zep meters credits per 350-byte episode). (Superseded in part 2026-09-02, see `docs/decision-log.md` D12: the model-free floor is capture, dedup, the ledger, search, timeline, context, audit and undo; canon writing requires a configured model.)
- Personal-LIFE capture breadth: platforms structurally can't (ChatGPT/Claude memory only see their own conversations), work tools won't (Notion, Granola, Tana are work-canon), and hosted consumer apps died trying (Limitless, Bee, Dot). Telegram+WhatsApp+email+calendar+wearables fused into one owner-custodied record is unserved — Bee validated exactly this fusion with the wrong custody model.
- Exit-proofness as a marketed feature: three mass-deletion events in 13 months (Omnivore 14-day window, Pocket deletion deadline, Meta disabling Rewind capture) created a burned, articulate refugee audience, and Readwise/Karakeep both grew off the funerals. 'Our death costs you nothing — it's markdown on your disk' plus launch-day importers for the graveyard is free acquisition nobody is systematically running.
- Provenance-stamped plaintext canon: Graphiti's bi-temporal facts (valid-from/valid-until + provenance to source episode) is the only prior art and it lives in a Neo4j graph nobody can self-host easily. Promoted markdown claims that carry timestamps and a link back to the raw queue event exists nowhere.
- The owner-facing memory product generally: category money went entirely to developer APIs (mem0, Zep, cognee, supermemory) and the platforms took casual personalization, leaving 'a memory system whose customer is the person being remembered' occupied only by indie-scale Basic Memory — thin competition for Kokoro's actual buyer.

## Threats (who kills Kizuki and how)

- screenpipe adds a distill/review layer: the highest-probability kill. Funded (YC S26), 21.4k stars, weekly releases, already has event-driven local capture, SQLite, MCP, and the category's only enforced permission gating. A 'pipes' template that summarizes the day into reviewable markdown closes most of Kokoro's gap for its existing hundreds-of-thousands of installs; Kokoro's remaining moat would be only license posture (their MIT→commercial flip) and true zero-telemetry. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- supermemory ships a review UI on top of its connector stack: it already has the closest overall shape — Gmail/Drive/Notion connectors, MCP, browser extension, consumer app, 'one binary zero config' local mode — plus ~$29M and press velocity. If it adds owner-visible staged memories (its OpenMemory-style dashboard is halfway there), it outmarkets Kokoro to the same audience while Kokoro is still building connectors. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Basic Memory (or mem0's OpenMemory MCP) grows a capture pipeline: Basic Memory already owns markdown+SQLite+MCP with real users; OpenMemory MCP (https://mem0.ai/blog/introducing-openmemory-mcp) already markets 'local, private, portable memory' with a management dashboard and docker-compose install. Either adding ingest connectors + a staging queue arrives at Kokoro from the opposite direction with an installed base.
- Platform memory becomes good enough: ChatGPT memory is default-on for the largest user base on earth and Claude memory ships free on all plans — 'the AI remembers me' is commoditized, shrinking Kokoro's market to people who specifically care about custody, review, and cross-vendor portability. If OpenAI/Anthropic add connector-based life capture (both are adding connectors), the casual segment never arrives at Kokoro. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- An Obsidian plugin eats the wedge: Reor died proving that a standalone app whose differentiator overlaps the incumbent editor loses the moment plugins catch up. Copilot and Smart Connections already monetize inside the vault; a 'capture inbox + review queue' plugin from either dev, distributed through Obsidian's community-plugin firehose, would reach Kokoro's exact audience with zero install friction. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Kokoro kills Kokoro — the category's own failure distribution: solo-maintainer death (Dendron wound down at 100k users, Reor archived, Foam dormant), install friction (Khoj's Django+Postgres is the canonical complaint; Wallabag lost to Karakeep on install alone), the connector treadmill (Beeper needs a 30-person Automattic-funded team for 12 bridges), a breaking rewrite (Logseq's 3-year bleed, Letta archiving V1), or a trust-burning license flip once money pressure arrives (screenpipe, Smart Connections). Any one of these is fatal independent of competition.
- Acqui-hire gravity on adjacent rails: Automattic (Beeper), Amazon (Bee), and Meta (Limitless) show big tech buys the capture endpoints; if a messaging-capture or wearable player bundles a 'your life, summarized' memory layer at platform scale and $0, Kokoro competes against free with distribution.

## Design implications (checkable, cited)

1. Install must be one command to first staged capture, zero API keys, zero external services: Karakeep (single docker-compose, 28.7k stars in 3 years) lapped Wallabag (PHP+Composer+MariaDB, 10+ years) on install friction alone; Khoj's Django+Postgres stack is its #1 self-hoster complaint; supermemory's 'one binary, zero config' and cognee's embedded SQLite/LanceDB mode set the 2026 bar. Check: fresh VM → running system with events staged for review in ≤2 commands and ≤5 minutes, no keys.
2. Canon is markdown files on the owner's disk, forever, no exceptions for performance: Logseq's database rewrite (files→DB) fractured its 44.7k-star community and forced a product split; Anytype's custom object store generates permanent export anxiety in every comparison thread; every survivor (Obsidian ecosystem, SilverBullet, Basic Memory) keeps files as truth. Check: deleting the Kokoro binary and index leaves a complete, human-readable, Obsidian-openable wiki; the index (SQLite) is rebuildable from files alone.
3. Publish license AND revenue posture in the README on day one, and never meter recall: screenpipe's MIT→commercial flip (June 2026) and Smart Connections' MIT→restrictive flip each spawned an 'alternatives' industry; Mem's capped free chats and Notion's agent credits read as hostage-taking; the only non-backlash pattern is Anytype/Obsidian/Basic Memory's 'free local forever, pay for sync/hosted convenience'. Check: README states license, what will never cost money (capture, canon, MCP, review), and what might (managed sync, hosted inference), before v0.1.
4. Zero-phone-home must be literally true including analytics, and verifiable: screenpipe ships default PostHog/Sentry telemetry inside a 'local-first' app and communities noticed; Omi defaults audio through Deepgram+Firebase under an MIT banner; Rewind's cloud activation became Meta's remote kill switch. Check: no telemetry SDK in the dependency tree, a CI test asserting zero non-localhost sockets during a full capture→promote cycle, and a documented `iptables`-style audit recipe users can run themselves.
5. The deterministic floor is load-bearing, not a footnote: capture, queue, dedup, search, schema validation, and promotion must all work with no LLM configured — Zep metering credits per 350-byte ingested episode exposes per-event-LLM cost as the category's hidden tax; SilverBullet (Lua+frontmatter queries), ActivityWatch, and HPI/Dogsheep prove deterministic value ships; LLM-load-bearing products (Reor, Khoj) aged with model churn. Check: full pipeline integration test passes with LLM providers disabled; LLM only ever drafts proposal text. (Superseded in part 2026-09-02, see `docs/decision-log.md` D12: the model-free floor is capture, dedup, the ledger, search, timeline, context, audit and undo; canon writing requires a configured model.)
6. First run must yield a same-day artifact, with canon as the by-product: Granola (great meeting notes today, memory as side effect) went $250M→$1.5B in ten months while Mem burned $28.6M on abstract 'self-organizing memory' and hasn't raised since 2022; ActivityWatch's decade proves capture-without-payoff plateaus. Check: within 24h of install a user has a generated daily brief/digest from their own data, before they have promoted a single page.
7. Review ergonomics are a daily digest with one-tap promote/reject, not per-event nagging: Bee's daily insight cards and Granola's immediate-artifact flow are the proven surfaces; Mem 1.0's uninspectable auto-filing destroyed trust; Bee's hallucinated to-dos are a live complaint precisely because there was no approval step. Check: median daily review session ≤5 minutes at realistic event volume; instrument and track proposal acceptance rate as the product's core quality metric.
8. Append-only queue; proposals never mutate canon in place; promotion writes a new dated, provenance-stamped revision: mem0's April 2026 algorithm retreat to ADD-only extraction with retrieval-time reconciliation validates append-only over UPDATE/DELETE of memories; Anthropic's memory tool letting the model str_replace canonical files is the exact hazard; Graphiti's bi-temporal facts (valid-from/valid-until + provenance to source episode) is the pattern to stamp at promote time. Check: every canon claim carries a date and a link resolving to the raw queue event(s) it came from; git history shows only additive promote commits.
9. MCP is read-only with sensitivity gating enforced below the prompt layer, free: unreviewed MCP write access demonstrably pollutes graphs (Basic Memory duplicate entities, Anytype write-mode); screenpipe's declarative YAML allow/deny (apps/windows/time-ranges) enforced at OS level is the only prior art and it's gated to $150/seat enterprise — shipping it free and personal is a stated wedge. Check: a sensitivity: frontmatter tier on every canon page; an MCP integration test proving a gated page is invisible to an agent query while readable to the owner; no write verbs in the MCP surface at all.
10. Connectors are adapters over existing rails, never first-party protocol maintenance: Beeper keeps ~12 messaging bridges alive with a 30-person Automattic-funded team, Composio maintains 1,089 toolkits on VC money — a solo OSS project promising 'we maintain WhatsApp' drowns. Check: messaging ingest documented as an adapter over mautrix bridges/Beeper exports; email via IMAP; calendar via CalDAV/ICS; wearables via export-file importers (WHOOP CSV, Bee/Omi exports); ActivityWatch via its bucket REST API; a connector SDK so the community carries the long tail.
11. Launch with importers for the graveyard: every 2025-26 winner shipped Pocket/Omnivore importers within weeks of each shutdown and Karakeep rode the funerals to 28.7k stars; Readwise absorbed the Pocket refugee wave into ~$14M ARR. Check: v1 ships working importers for Pocket CSV, Omnivore export, Readwise markdown, ActivityWatch buckets, and ChatGPT/Claude data exports, each listed on the landing page as a named feature.
12. Canon pages are typed entities with machine-validated frontmatter schemas, checked deterministically at promote time: Capacities' typed objects are the best-articulated personal-world-model schema but demand manual ontology labor (its enthusiast ceiling); Dendron's schema system is the only prior art for machine-checked structure over plaintext; SilverBullet's frontmatter-as-database proves deterministic queryability. Check: promoting a proposal that violates the page-type schema fails with a diff; the owner only ever approves drafts, never hand-builds ontology.
13. Never break the substrate — additive migrations only, no big rewrite, and a written sunset plan: Logseq's 3-year rewrite bled its community, SilverBullet's v1→v2 cost users at smaller scale, Letta archived its V1 server under its own installed base, and Dendron wound down quietly on Discord, stranding 100k users; Dot's advance-notice+export wind-down is the ethical minimum. Check: canon format versioned with forward-compatible additive changes only; SUNSET.md in the repo from day one stating what happens to user data if the project dies (answer: nothing — it's their files).
14. Refuse benchmark marketing; compete on properties no benchmark measures: the mem0-vs-Zep LoCoMo knife fight (84%→'corrected' to 58%→rebutted at 75%) burned credibility on both sides, and mem0/supermemory/Honcho all simultaneously claim #1 — recall numbers are unfalsifiable marketing in this category. Check: README/site contain zero recall-benchmark claims; the demo instead shows the auditable trail (event → proposal → owner diff → promoted page → agent citation) end to end.
15. Ship as vault-compatible with Obsidian rather than building an editor, but own the review surface: Reor (archived Mar 2026) proved a standalone AI-notes app loses to the incumbent's plugin ecosystem; Basic Memory gets 'free UI' via Obsidian compatibility; Foam shows living entirely inside someone else's editor caps the roadmap. Check: canon directory opens cleanly as an Obsidian vault (wikilinks, frontmatter render); the review/queue UI is Kokoro's own surface, the editing/browsing experience is delegated. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)

---

# Product sheets


## OSS local-first engines

### mem0 — threat: medium

The category leader in developer-facing agent memory: an API/SDK that auto-extracts, stores, and retrieves 'memories' from conversations at user/session/agent scope. As of April 2026 shipped a new single-pass ADD-only extraction algorithm (no UPDATE/DELETE ops) with entity linking, hybrid retrieval (semantic + BM25 + entity), and temporal reasoning; claims LoCoMo 92.5 / LongMemEval 94.4.

- **Architecture:** Cloud-first with a real self-host path: pip/npm library for local prototyping, Dockerized self-hosted server, and the managed platform at app.mem0.ai as the actual business. Vector-store-backed hybrid search; graph memory optional. LLM required for extraction (default GPT-5-mini) — no deterministic floor. No review gate: extraction is fully automatic. Apache 2.0. Not markdown, not user-legible storage.
- **Traction:** 64.5k GitHub stars / 7.6k forks (Sept 2026). $24M Series A Oct 2025 led by Basis Set with Peak XV, YC, GitHub Fund. 14M downloads; API calls 35M (Q1 2025) → 186M (Q3 2025). Picked as exclusive memory provider for AWS Strands agent SDK May 2025. YC S24.
- **Steal:** Distribution playbook: agent-skill packages for Claude Code/Cursor/Windsurf and framework integrations everywhere an agent lives — Kokoro's MCP surface should be equally trivially installable. Also the multi-signal retrieval design (semantic + keyword + entity) and the April-2026 lesson that append-only extraction with retrieval-time reconciliation beats in-place UPDATE/DELETE of memories — that maps directly onto Kokoro's durable queue + staged proposals.
- **Avoid:** Opaque memory: users and even developers can't easily audit what was extracted or why, and silent auto-extraction is the whole design — exactly the anxiety Kokoro's owner-review gate answers. Also avoid their benchmark-war marketing posture (see Zep dispute); numbers moved 20+ points between their own releases, which tells you the metric is soft. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/mem0ai/mem0 · https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/ · https://www.prnewswire.com/news-releases/mem0-raises-24m-series-a-to-build-memory-layer-for-ai-agents-302597157.html

### Zep / Graphiti — threat: low

Graphiti is an open-source temporal knowledge-graph framework for agents (facts with validity windows, provenance to source episodes, incremental updates without recomputation); Zep is the commercial platform on top, repositioned through 2026 as a 'context engineering' / Context Lake product with governance, retention policies, and low-latency Context Graph Engine.

- **Architecture:** Graph-native and infra-heavy: requires Neo4j 5.26+/FalkorDB/Neptune plus an LLM (OpenAI default) for every episode ingested. Ships an MCP server and FastAPI service. Cloud product is the business; self-hosting Graphiti is genuinely possible but you operate a graph DB. Apache 2.0 core, proprietary cloud. No owner review; automatic graph construction. Notably keeps provenance from fact → source episode, which is rare and good.
- **Traction:** Graphiti ~30.5k stars / 3.1k forks (Sept 2026; Zep itself cited 24k+ in Aug 2026). YC W24, still self-described seed-stage Aug 2026 with 240+ customers incl. Fortune 500. Pricing from $125/mo, credit-metered per ~350-byte episode chunk — ingestion is the cost center, retrieval free.
- **Steal:** Two things: (1) bi-temporal facts — every canonical claim carries valid-from/valid-until plus provenance to the raw episode; Kokoro's promote step should stamp exactly this. (2) Pricing/cost honesty: metering per ingested episode makes visible that LLM-per-event ingestion is the expensive part — Kokoro's deterministic floor is the structural answer. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** The graph-DB operational tax: 'install Neo4j first' kills stranger-installability, which is why Zep's real business is cloud. Also their 84%-LoCoMo claim got publicly corrected to 58% by mem0 and re-rebutted to 75% — the benchmark knife-fight burned credibility on both sides.
- **Sources:** https://github.com/getzep/graphiti · https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ · https://github.com/getzep/zep-papers/issues/5 · https://grokipedia.com/page/zep_company

### cognee — threat: low

Berlin open-source 'AI memory platform': ingest heterogeneous data, run a remember-cognify-recall (ECL) pipeline that builds a combined knowledge graph + vector layer agents reason over. Went from experiment to production infra in 2025 (~2k → 1M+ pipeline runs).

- **Architecture:** Closest of the dev-infra players to local-first: runs fully embedded with SQLite + LanceDB + Kuzu, no external services — but still requires an LLM API key to cognify (OpenAI default), so no deterministic floor. Multiple graph/vector backends, Python primary with a Rust engine (cognee-rs) being built explicitly for on-device/edge. Apache 2.0; Cognee Cloud is the monetization. Automatic graph construction, no human review gate.
- **Traction:** 30.4k stars / 3.0k forks (Sept 2026). $7.5M seed led by Pebblebed with 42CAP, Vermilion, DeepMind/n8n angels, announced ~Feb 2026. 70+ companies using OSS; 500x pipeline-run growth in 2025.
- **Steal:** The embedded-by-default posture (SQLite/LanceDB/Kuzu in-process, zero services) is the right stranger-install floor and proves it's viable at 30k stars. Their 'self-improving memory graph' framing and the Rust-for-edge bet validate Kokoro's local-first thesis with investor money behind it.
- **Avoid:** Cognify is a black box — LLM-built graphs the owner never reviews, so garbage propagates silently into the memory layer; and per-ingest LLM cost scales with your life, not your questions. Also dev-tool positioning: no consumer/owner surface at all, which leaves Kokoro's lane open. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/topoteretes/cognee · https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed · https://www.eu-startups.com/2026/02/german-ai-infrastructure-startup-cognee-lands-e7-5-million-to-scale-enterprise-grade-memory-technology/

### Letta (MemGPT) — threat: medium

The original agent-memory project (MemGPT, 2023) turned platform company — and the category's biggest strategy lesson: in 2026 it pivoted its center of gravity from a memory/agents server to Letta Code, a memory-first coding agent (desktop app Apr 2026, Channels May 2026, Mods Jun 2026, Agents SDK Aug 2026). The flagship memory idea is now 'Context Repositories': programmatic context management with git-based versioning.

- **Architecture:** Model-agnostic, local-capable (`letta server`, desktop app, agents that 'work locally on your machine') plus Letta Cloud. Memory as self-editing in-context blocks evolved into file/git-versioned context repos — i.e., they independently converged on versioned files as the memory substrate. Apache 2.0. The main letta repo is now a landing page; V1 server archived/unsupported — a hard fork of their own installed base.
- **Traction:** 24.5k stars on the (now landing-page) main repo, Sept 2026. ~$10M seed (2024). Letta Code claims 42.5% Terminal-Bench, billed #1 model-agnostic open-source coding agent. Real momentum, but the memory-infra product itself was effectively sunset.
- **Steal:** Context Repositories: git-versioned, file-based, human-inspectable memory with history is precisely Kokoro's canon architecture — Letta arriving there from the opposite direction is strong external validation. Also their positioning line 'memory that persists across models, machines, and interfaces' is the correct anti-platform pitch.
- **Avoid:** The pivot itself is the warning: standalone 'memory server for developers' didn't hold as a business even for the inventors of the category — memory got absorbed into an agent harness. Also the archived-V1 whiplash: breaking your installed base's substrate destroys the trust a canon product depends on.
- **Sources:** https://github.com/letta-ai/letta · https://www.letta.com/blog/letta-code/ · https://www.letta.com/blog/our-next-phase/ · https://www.letta.com/blog/towards-agents-that-learn/

### LangMem — threat: low

LangChain's long-term-memory library for LangGraph agents: memory-tool calls agents can invoke, plus a background manager that extracts/consolidates knowledge into LangGraph's store. Alive but minor — a feature of an ecosystem, not a product.

- **Architecture:** Library, not system: storage-agnostic API over LangGraph BaseStore (in-memory to Postgres), LLM required for extraction, MIT license. No capture, no canon, no review, no consumer surface. Tightly coupled to the LangGraph ecosystem at exactly the moment production teams are reportedly migrating off framework abstractions to raw SDKs.
- **Traction:** 1.6k stars / 187 forks; ~746K monthly and 5M+ total PyPI downloads (mid-2026), but latest release 0.0.30 from Oct 2025 — pre-1.0 with slow cadence; survived the LangChain 1.0 transition as the blessed long-term-memory option while legacy Memory classes were deprecated.
- **Steal:** The clean two-lane API split — 'hot path' memory tools the agent calls deliberately vs. background consolidation — is a good mental model for Kokoro's queue: explicit owner actions and asynchronous proposal generation as separate, named lanes. (Kizuki-side note: the staging queue feeds the receipted writer, not a person; superseded framing 2026-09-02, see `docs/decision-log.md` D9 and D10.)
- **Avoid:** Being an ecosystem accessory: its adoption ceiling is LangGraph's adoption, and its release cadence shows what happens when memory is a side project. Nothing here competes for the owner's trust or data.
- **Sources:** https://github.com/langchain-ai/langmem · https://rywalker.com/research/langmem · https://ravoid.com/blog/langchain-exit-raw-sdk-migration-2026/

### OpenAI ChatGPT memory — threat: high

Platform memory at maximum distribution: saved memories (user-editable facts) + reference-chat-history, and since June 2026 'Dreaming' — a background process that reads years of your conversations and autonomously rewrites its profile of you (claimed factual recall 41.5% → 82.8% vs the 2024 system), including silently revising memories as facts go stale.

- **Architecture:** The exact inverse of Kokoro on every axis: cloud-only, closed, non-portable, no export of the memory substrate, no review gate (you can edit/delete afterward, and Temporary Chat opts out, but synthesis is automatic and opaque), phone-home is the product. Scope limited to ChatGPT conversations plus its connectors — it does not capture your Telegram/WhatsApp/wearables life. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Traction:** Default-on for the largest AI user base on earth; June 2026 Dreaming rollout. No pricing signal needed — it's a retention feature, and it sets the mass-market's expectation of what 'AI that knows me' means.
- **Steal:** Two ideas worth keeping: memory as a synthesized, continuously maintained profile (not just a fact list) is what makes recall good — Kokoro's promoted canon plays this role with the owner in the loop; and staleness handling (revising time-bound facts once dates pass) belongs in Kokoro's proposal engine. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** The trust failure mode is documented in real time: coverage literally titled 'ChatGPT now quietly rewrites its memories of you… and that's unsettling.' Autonomous rewriting of the record without a review gate is the single strongest argument for Kokoro's existence — do not soften the gate to chase recall benchmarks. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://openai.com/index/memory-and-new-controls-for-chatgpt/ · https://www.xda-developers.com/chatgpt-quietly-rewrites-its-memories-of-you-not-sure-i-like-it/ · https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide

### Anthropic Claude memory — threat: medium

Claude's memory stack: chat memory rolled out to all users (free included) by March 2026 as an extracted running summary; per-Project isolated memory spaces; and for developers the API memory tool (memory_20250818) — a client-side file directory the model manages with view/create/str_replace/insert/delete/rename ops.

- **Architecture:** Consumer side mirrors ChatGPT (cloud, automatic extraction, view/manage after the fact, no promotion gate). The API memory tool is architecturally interesting for Kokoro: memory as plain files in a directory the developer hosts — Anthropic's own answer is 'files the client owns,' not a vector DB. Project-scoped memory isolation is a real sensitivity-gating primitive. Still platform-bound and non-capturing beyond Claude surfaces/connectors. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Traction:** All-plans rollout March 2026; memory tool shipped in the platform API (beta Oct 2025, GA docs 2026). Distribution is Anthropic's whole user base; like ChatGPT it commoditizes casual personalization rather than competing for the canon.
- **Steal:** File-directory memory as the official API pattern legitimizes Kokoro's markdown-canon-over-MCP design — Claude models are literally trained to operate on file-based memories, so Kokoro's read-only MCP over markdown is swimming with the current. Also steal per-Project memory isolation as prior art for sensitivity scoping.
- **Avoid:** Platform lock: memory lives where the vendor lives and evaporates across vendors — Kokoro should hammer portability. Also note their client-side memory tool has no reconciliation/review semantics; naive str_replace by the model on canonical files is exactly what Kokoro's staging queue must prevent. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://its.syr.edu/claude-has-a-memory-heres-how-to-use-it/ · https://www.shareuhack.com/en/posts/claude-memory-feature-guide-2026

### Honcho (Plastic Labs) — threat: low

Open-source 'memory and identity' layer with a peer-centric model: humans and agents are equal 'peers,' messages are stored synchronously, and an async reasoning pipeline (queue → deriver → conclusions/representations) builds theory-of-mind models of what each peer knows/believes. Through 2026 repositioned from memory infra toward an 'AI identity platform.'

- **Architecture:** Cloud-first (api.honcho.dev, $100 free credits) with self-host via Docker/FastAPI; AGPL-3.0 as the cloud moat. Requires external LLM keys for the reasoning pipeline — psychology modeling is inherently LLM-heavy, no deterministic floor. Postgres-backed; no user-legible canon, no review gate — the derived representation is the product and it's machine-inferred.
- **Traction:** ~7k stars / 865 forks (Sept 2026). $5.35M pre-seed 2025 (Variant, White Star, Betaworks, Mozilla Ventures); 2026 filings indicate a Series A in the $13-15M range. Integrations with Claude Code/OpenCode; claims Pareto-frontier long-conversation benchmarks. Real but an order of magnitude behind mem0/Zep in adoption.
- **Steal:** The storage/insight split — synchronous durable message log, asynchronous derivation into queryable representations — is structurally identical to Kokoro's queue→proposal pipeline and is proven at production scale. Their framing that representations should answer 'what does X know about Y' (per-peer perspective) is a sharp query model for a world model. (Kizuki-side note: the staging queue feeds the receipted writer, not a person; superseded framing 2026-09-02, see `docs/decision-log.md` D9 and D10.)
- **Avoid:** Inferring user psychology without owner review is the maximally creepy version of auto-extraction — a theory-of-mind dossier the subject never approved. Also their drift from 'memory' to 'identity' branding suggests the memory-API positioning wasn't converting on its own. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/plastic-labs/honcho · https://app.dealroom.co/news/feed/plastic-labs-raises-5-35m-launches-honcho · https://plasticlabs.ai/

### Supermemory — threat: high

[ADDED — belongs in this category] Universal memory API + consumer surface from a 19-year-old founder: hosted platform with life-capture connectors (Gmail, Google Drive, Notion, GitHub), a browser extension, Claude/Cursor plugins, an MCP server, and a local mode marketed as 'one binary, zero config' at localhost:6767 with optional offline Ollama. Claims #1 on LongMemEval, LoCoMo, and ConvoMem.

- **Architecture:** The closest overall shape to Kokoro: capture connectors + personal memory + MCP + a genuine local/offline story. But cloud-first in practice (the API business), MIT-licensed OSS as funnel, automatic extraction with no owner-review canon, storage not user-legible markdown, and the local binary is a tier, not the center of gravity. LLM-dependent for extraction (Ollama option gives a weak local floor). (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Traction:** 29.2k stars / 2.5k forks (Sept 2026). $2.6-3M seed Oct 2025 led by Susa Ventures/Browder/SF1 with angels incl. Jeff Dean and Cloudflare's CTO; heavy TechCrunch/press cycle. Fast-moving solo-founder-energy project rather than proven revenue.
- **Steal:** 'One binary, zero config' is the stranger-install bar Kokoro must meet or beat. Also the origin story: it started as personal capture (Twitter bookmarks → life memory), which validates capture-first consumer demand; and its connector list is a ready-made roadmap ordering.
- **Avoid:** Trying to be memory-for-everyone (consumer app + dev API + enterprise) at seed stage — the positioning smears. And its benchmark-supremacy marketing (#1 on three benchmarks, in a category where every vendor claims #1) is exactly the credibility trap to skip.
- **Sources:** https://github.com/supermemoryai/supermemory · https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/ · https://supermemory.ai/blog/supermemory-raises-3-million-and-building-the-best-memory-engine-for-llms

### Basic Memory (Basic Machines) — threat: high

[ADDED — belongs in this category] The nearest architectural neighbor to Kokoro's canon layer: a local-first knowledge system where humans and LLMs read/write the same structured Markdown files on the user's disk, indexed into a knowledge graph, exposed to Claude Desktop/Code, Cursor, ChatGPT and Obsidian via an MCP server.

- **Architecture:** Local-first plain Markdown + SQLite index (Postgres/Milvus optional for semantic search), MCP-native, Obsidian-compatible, AGPL-3.0 with a cloud offering ($15/mo 'locked for life', Teams workspaces). Crucially it is write-through: the agent edits canon directly during conversation — there is no capture pipeline from your digital life and no staged-proposal/owner-promotion gate. LLM lives in the client, not the store — effectively a deterministic core.
- **Traction:** 3.8k stars / 270 forks, ~1.9k commits (Sept 2026); active Discord, real testimonials, small paid cloud. Sustainable-indie scale, not venture scale — which itself is evidence the pure 'markdown memory over MCP' wedge monetizes modestly.
- **Steal:** Almost everything about the storage contract: human-and-agent-legible Markdown as the single source of truth, SQLite as disposable index, Obsidian interop for free UI, MCP as the only agent surface. Kokoro = Basic Memory's canon layer + the capture/queue/review machinery Basic Memory lacks — that's a clean one-line differentiation. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** Write-through agent edits to canon with no review gate (trust erosion at scale), and AGPL if Kokoro wants maximum stranger adoption — license friction shows up in their contribution rules too (PRs only against maintainer-approved issues). (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/basicmachines-co/basic-memory

**Category lessons:**
- The money in this category (mem0 $24M, cognee $7.5M, Plastic Labs ~$5M+A, Supermemory seed, Zep) is ALL selling memory APIs to developers; the platforms (ChatGPT Dreaming, Claude memory) own casual consumer personalization. Nobody occupies 'owner-reviewed, user-owned, zero-phone-home personal canon' — Kokoro's lane is genuinely empty, but note it's empty partly because it's hard to monetize (Basic Memory, the closest occupant, is indie-scale at $15/mo). (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Benchmark wars are the category's marketing pathology: Zep claimed 84% LoCoMo, mem0 'corrected' it to 58%, Zep rebutted at 75%, and mem0, Supermemory, and Honcho each claim #1/SOTA on overlapping benchmarks. Recall numbers are unfalsifiable marketing here. Kokoro should refuse to compete on recall and compete on properties no benchmark measures: auditability, ownership, review, portability. Superseded 2026-09-02, see `docs/decision-log.md` C8 and D10: the owner review gate is no longer a claim anywhere; the restated moat is autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness. The property to compete on is reversibility and total provenance, not review.
- Silent auto-extraction is the universal architecture and the universal trust problem — ChatGPT's Dreaming 'quietly rewrites its memories of you' (verbatim press framing), Honcho derives psychological dossiers, mem0/cognee build opaque stores. The owner-promotion gate is Kokoro's sharpest differentiator; every competitor's roadmap moves AWAY from human review because their metric is recall, not trust. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- The field is independently converging on Kokoro's substrate: Anthropic's official memory tool is a file directory the client owns; Letta rebuilt memory as git-versioned 'Context Repositories'; Basic Memory proved Markdown+SQLite+MCP works. Files the owner can read, diff, and version are winning over graph databases — Graphiti's Neo4j requirement and Zep's cloud-only business show the graph-DB tax kills self-host adoption.
- Per-event LLM ingestion is the hidden cost structure of the whole category: Zep meters credits per 350-byte episode, mem0/cognee/Honcho all require LLM keys just to ingest. A deterministic floor (LLM optional, capture and canon work without any model) is rare to nonexistent among competitors and is both a cost and a privacy differentiator — lead with it.
- Pivot graveyard lesson: MemGPT→Letta→Letta Code shows even the category inventors couldn't sustain 'memory infra' as a standalone product — memory got absorbed into an agent harness; Honcho drifted from 'memory' to 'identity' branding. Pure memory-layer positioning trends toward feature-not-product. Kokoro avoids this by being the OWNER's system (capture-to-canon world model with a review workflow), not an API another product swallows. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Stranger-installability has a measurable bar now: Supermemory's 'one binary, zero config' and cognee's fully-embedded SQLite/LanceDB mode define the floor. Anything requiring Docker-compose + Neo4j + API keys before first value loses the install race. Kokoro's first-run must produce visible value (captured events staged for review) with zero external services and zero keys. (Kizuki-side note: the staging queue feeds the receipted writer, not a person; superseded framing 2026-09-02, see `docs/decision-log.md` D9 and D10.)
- Platform memory (ChatGPT to all users, Claude to all plans, both free) has commoditized 'the AI remembers me' — the surviving wedges are exactly what platforms structurally cannot do: capture across WhatsApp/Telegram/email/wearables/desktop, memory portable across model vendors (Letta's explicit repositioning), and a canon the user owns when the subscription ends. Market Kokoro against the platforms, not against mem0.


## Hosted personal AI / lifelogging

### Limitless (ex-Rewind) — threat: low

AI wearable pendant + desktop/web recording that captured everything you heard and said, with a lifelog app on top. Acquired by Meta on Dec 5, 2025; pendant pulled from sale, Rewind app sunset (all screen/audio capture disabled Dec 19, 2025), service killed outright in the EU/UK/Brazil/China/Israel/South Korea/Turkey, existing users moved to a free plan with support only 'through 2026'.

- **Architecture:** Hosted 'confidential cloud' — audio uploaded and processed server-side; proprietary app store; no user-ownable canon. Rewind had started local-first (on-device screen recording) and drifted to cloud with the pendant pivot. LLM mandatory. Export = transcript download before a deletion deadline (users in cut-off regions got ~2 weeks).
- **Traction:** Pendant $99→$199→$399, Pro $19/mo pre-acquisition. Meta acqui-terms undisclosed (Dec 2025). As of mid-2026 hardware unbuyable, support cliff ~Dec 2026.
- **Steal:** The lifelog UX proved demand for ambient capture → queryable personal memory; pendant hardware at $99 proved capture endpoints commoditize. Their transcript-export flow under shutdown pressure is the exact disaster Kokoro's markdown canon makes impossible.
- **Avoid:** Cloud custody of the most intimate dataset a person has: acquisition instantly stranded paying users, deleted regions overnight, and set a data-deletion countdown. Also: hardware pivot burned the working software product (Rewind) its users loved.
- **Sources:** https://www.limitless.ai/ · https://luci.memories.ai/blog/limitless-pendant-discontinued-alternatives · https://www.usecarly.com/blog/limitless-ai-alternatives/ · https://fast.io/resources/limitless-ai-review-2026/

### Mem.ai — threat: medium

'Your AI chief of staff' — hosted AI notes workspace plus a proactive agent that tracks tasks/projects from what you capture (voice push-to-remember, meetings, web clips). Mem 2.0 shipped late 2025 with new pricing (effective Oct 1, 2025) after years of drift; widely used as the cautionary '$28M second-brain' story.

- **Architecture:** Cloud-only, closed source. Notable claim: 'memory lives in familiar notes — not a hidden file or opaque chat history' (visible memory, an implicit nod toward Kokoro-style inspectable canon). Ships a Claude connector for LLM context access. Auto-organization, no review gate. LLM mandatory.
- **Traction:** $28.6M raised (a16z, OpenAI Startup Fund, Founders Fund, 2021-2022); no follow-on since. Free tier capped at 25 chats/25 PDF pages per month; Pro ~$12-15/mo. Community verdict trended 'failure that fixed itself too late'; Mem 2.0 fixed speed/stability but momentum is gone.
- **Steal:** Visible-memory framing ('your memory is your notes, not a hidden vector store') — Kokoro's promotable markdown canon is the honest version of this pitch. Push-to-remember voice capture is a good low-friction capture verb. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** Auto-organized 'self-organizing workspace' overpromise — AI filing that users can't inspect or correct destroyed trust in 1.0 and no funding round has followed since 2022. Metered free tier on a memory product reads as hostage-taking.
- **Sources:** https://get.mem.ai/ · https://medium.com/@theo-james/mem-ai-the-40m-second-brain-failure-burning-the-worlds-money-5f3176a34cbd · https://blog.saner.ai/mem-ai-reviews/ · https://www.solidaitech.com/2026/07/mem-ai-note-taking-app-vs-mem0-api.html

### mymind — threat: low

Private visual memory/bookmarking app ('a private place for everything you care about') — save images, links, notes; AI auto-tags; associative search by color/brand/keyword. Deliberately anti-social: no sharing, no collaboration, no likes.

- **Architecture:** Hosted cloud, closed source, privacy as marketing position not architecture (no E2E, no local store, no export-first design — reviewers flag import/export and integration limits). AI tagging server-side. No agent/MCP surface at all.
- **Traction:** Bootstrapped/indie (Tobias van Schneider). Pricing ~$5.99-12.99/mo tiers plus a coming $299/yr 'Newton' plan. Loyal design-crowd niche; no public user numbers; steady but small through 2026.
- **Steal:** Frictionless capture with zero filing decisions at save time — capture first, structure later is the right emotional contract, and maps to Kokoro's queue→review split. Also proof that 'private, no feed, yours' is a marketing position people pay for. (Kizuki-side note: the staging queue feeds the receipted writer, not a person; superseded framing 2026-09-02, see `docs/decision-log.md` D9 and D10.)
- **Avoid:** Privacy-as-vibe without privacy-as-architecture: no export path and cloud custody contradict the pitch. Deliberately capping capture sources (no email/chat ingest) caps the ceiling at bookmarking.
- **Sources:** https://www.capterra.com/p/10015233/mymind/ · https://usethisai.com/tool/mymind/ · https://www.producthunt.com/products/my-mind/reviews

### Capacities — threat: low

Object-based PKM ('you don't write documents about things, you create the things') — people, books, meetings as typed objects with properties, backlinks, daily notes, an AI assistant. Small European team, steady niche among structured-thinking enthusiasts.

- **Architecture:** Hosted cloud sync (free tier 5GB media), closed source, not local-first, markdown export exists but canon lives in their object store. AI assistant optional (closest thing on this list to 'LLM optional'). No capture pipeline from messengers/email; no MCP surface as of the sources reviewed.
- **Traction:** No disclosed funding round found for 2025-2026; Free / Pro $9.99/mo / Believer $12.49/mo (verified May 2026). Alive and iterating, enthusiast-scale.
- **Steal:** Typed objects are the best-articulated schema for a personal world model — Kokoro's canon pages for people/places/projects should feel like Capacities objects (entity with properties + relations), not folders of prose.
- **Avoid:** Manual modeling burden: users must create and maintain the ontology themselves, which is why it stays an enthusiast tool. Kokoro's staged-proposal pipeline is the answer — the system drafts objects, the owner only approves.
- **Sources:** https://costbench.com/software/note-taking/capacities/ · https://aitoolscoop.com/tool/capacities/ · https://toolfinder.net/tool/capacities

### Tana — threat: medium

AI-native knowledge graph workspace: supertags (object-oriented templates), live queries, voice memos, AI meeting agent with live transcription, multi-model AI. Launched publicly Feb 2025 off a 160K+ waitlist.

- **Architecture:** Cloud-hosted proprietary graph, closed source; historically weak export (graph doesn't round-trip to markdown); LLM woven through the product. Work/team-oriented, not personal-life capture. No local mode.
- **Traction:** $25M total, $14M Series A led by Tola Capital at ~$100M valuation (Feb 2025); 160K+ waitlist spanning 80% of Fortune 500; 21K+ Slack community (2026); Free + ~$5/mo entry paid tier reported in 2026 reviews.
- **Steal:** Supertags: one gesture that turns unstructured capture into a typed node feeding live queries — the best existing UX for 'capture becomes structure'. Their voice-first capture → structured tasks flow is worth copying for Kokoro's proposal stage.
- **Avoid:** Graph lock-in: value accrues to a proprietary structure that can't leave. Complexity tax — 'is it worth the learning curve' is the standing review headline; a stranger-installable tool cannot demand ontology literacy on day one.
- **Sources:** https://techcrunch.com/2025/02/03/tana-snaps-up-25m-with-its-ai-powered-knowledge-graph-for-work-racking-up-a-160k-waitlist/ · https://siliconangle.com/2025/02/03/productivity-startup-tana-launches-25m-funding/ · https://aiproductivity.ai/tools/tana/

### Reflect — threat: medium

Fast networked note-taking with end-to-end encryption, daily notes, backlinks, GPT assistant. Bootstrapped-ish (small seed, then profitable by Dec 2023, no follow-on). March 2026: shipped an MCP server so Claude/Codex can search your notes directly.

- **Architecture:** Hosted but E2E-encrypted sync — the strongest privacy architecture among hosted PKM; closed source; markdown-ish export; LLM optional (notes work fine without AI). MCP read access to your notes is now first-class. Manual capture only — no life-ingest pipeline.
- **Traction:** $10/mo ($8 annual), no free tier. Profitable since Dec 2023 on a 3-engineer team; deliberately small; raised community money via Wefunder. No growth story that excites VCs — by design.
- **Steal:** The whole posture: small team, profitable, E2E, users-own-keys, and MCP as the agent surface. Reflect+MCP is the closest hosted analogue to Kokoro's 'agents query your notes read-only' — validation that the interface is right. Also: no free tier can work when trust is the product.
- **Avoid:** E2E without a capture pipeline means the notes only contain what you typed — the world model stays thin. Sub-scale traction shows manual-entry PKM alone doesn't grow; capture breadth is the differentiator.
- **Sources:** https://www.gotoolradar.com/2026/06/is-reflect-smartest-note-taking-app.html · https://www.billiondollarpitchdecks.com/startups/reflect · https://wefunder.com/reflect · https://checkthat.ai/brands/reflect

### supermemory — threat: high

Dual product: a universal memory API/'context infrastructure' for AI agents (hybrid vector+keyword, custom vector-graph engine, sub-300ms) plus a consumer 'personal app that remembers everything', with SDKs and an MCP server. Founder Dhravya Shah (20), the category's developer-mindshare darling.

- **Architecture:** Hosted API-first infra; MCP server; auto-ingest with no review gate; memory as opaque retrieval layer, not user-readable canon; cloud custody. Started as an OSS project (browser-history/bookmark memory) but the funded product is proprietary hosted infra.
- **Traction:** $26M seed Oct 2025 (TechCrunch reported the raise; company/Indian press cite ~$3M for an earlier round — reporting conflicts), ~$29M total across 2 rounds as of Jul 2026; backers include Jeff Dean, Cloudflare CTO, Logan Kilpatrick, Susa Ventures. Strong dev adoption narrative; consumer app traction unproven.
- **Steal:** Their positioning insight: sell to the agent era, not the note-taker era — 'give your agents memory' is the demand pull Kokoro's MCP surface should market into. Sub-300ms retrieval as a headline spec is the right kind of concrete claim.
- **Avoid:** Memory as a black-box API: nothing is inspectable, promotable, or owned; a hosted memory layer for your whole life is the exact phone-home Kokoro exists to refuse. Also the funding-number confusion shows hype outrunning verifiable reality. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://supermemory.ai/ · https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/ · https://dataconomy.com/2025/10/07/young-founders-supermemory-raises-2-6m-from-cloudflare-and-google-execs/ · https://startupintros.com/orgs/supermemory

### Notion AI — threat: medium

AI layer on the dominant workspace: personal Notion Agent (20+ minute multi-step runs) whose memory is stored as ordinary Notion pages/databases, AI Meeting Notes, Enterprise Search, connectors (Slack, Gmail, Drive, GitHub, Jira, Teams, Salesforce...), Custom Agents with MCP integrations.

- **Architecture:** Cloud workspace, closed source; agent memory deliberately stored as human-readable pages inside your workspace (the mainstream cousin of inspectable canon); permission-scoped agents; MCP both directions. Credit-metered agents ($10 per 1,000 monthly credits since May 4, 2026). Zero local-first story.
- **Traction:** Business plan $20/user/mo annual for full AI; 100M+ user platform distribution; agents+connectors are the 2026 flagship. Credit pricing drew grumbling but adoption is default-on for existing Notion users.
- **Steal:** Agent memory as readable pages inside the user's own workspace — Notion independently converged on 'memory should be documents the owner can read and edit'. Their permission-scoping of agent context is a mainstream articulation of sensitivity gating.
- **Avoid:** Metered credits for agent actions creates usage anxiety on a memory product. Workspace gravity means personal-life capture (chats, wearables, ambient) never happens — it's a work canon, not a world model.
- **Sources:** https://www.eesel.ai/blog/notion-ai-review · https://techjacksolutions.com/ai-tools/notion-ai/notion-ai-pricing/ · https://fayedtion.com/notion-ai-guide/

### Saner.ai — threat: low

ADHD-focused AI personal assistant unifying notes, tasks, email, and calendar in one workspace; AI surfaces context, breaks tasks down, drafts replies. Small indie team, actively shipping through 2025-2026.

- **Architecture:** Hosted cloud, closed source, LLM-mandatory, no local mode, no MCP surface found. Integration-hub model (connect email/calendar) rather than durable canon.
- **Traction:** Free / Starter $8/mo / Standard $16/mo (annual billing, 2026). No funding or user numbers disclosed; niche but alive, reviews note fast iteration Nov 2025-Jan 2026.
- **Steal:** Segment focus: 'built by ADHD people for ADHD brains' produces sharp product decisions (reduce decisions, surface next action). A capture-to-canon system is genuinely an ADHD prosthetic — Kokoro can borrow this audience framing without the niche ceiling.
- **Avoid:** Being an integrations thin-layer over email/calendar with no durable owned store — churn-prone, no moat, and each upstream API change breaks the product.
- **Sources:** https://www.eesel.ai/blog/saner-ai-pricing · https://theaitoolsbox.com/tool/saner-ai-review/ · https://opentools.ai/tools/sanerai

### Granola — threat: medium

AI meeting notepad (no bots in calls — captures system audio locally, blends your typed notes with transcript) expanding into 'turn meetings into AI memory' and enterprise context tools. The traction outlier of the category.

- **Architecture:** Desktop-native capture, cloud processing/storage, closed source; 2026 direction is company-wide context/memory tooling on top of meeting corpus; no review gate (auto-summarization); LLM mandatory. Privacy stance is UX-level (no visible bot) not architectural.
- **Traction:** $43M Series B at $250M (May 2025, NFDG) → $125M Series C at $1.5B (Mar 2026); ~5K weekly users at Series A (Oct 2024) then sustained ~10%/wk growth; revenue +250% in the quarter before Series C; logos: Vanta, Gusto, Asana, Cursor, Mistral.
- **Steal:** Capture that yields an immediate artifact (great meeting notes today) and builds the memory corpus as a side effect — the onboarding lesson for Kokoro: lead with a same-day payoff, let canon accrue. Invisible capture (no bot) beat every bot-based competitor.
- **Avoid:** Single-source capture (meetings) means the 'AI memory' is really a work-conversation archive; and $1.5B of expectations now force enterprise, abandoning the personal wedge.
- **Sources:** https://techcrunch.com/2026/03/25/granola-raises-125m-hits-1-5b-valuation-as-it-expands-from-meeting-notetaker-to-enterprise-ai-app/ · https://techcrunch.com/2025/05/14/ai-note-taking-app-granola-raises-43m-at-250m-valuation-launches-collaborative-features/ · https://www.reworked.co/digital-workplace/granola-raises-125m-launches-enterprise-context-tools/

### Personal.ai — threat: low

Once the flagship 'train an AI on your own memory stack' consumer play (founded 2020); has fully pivoted to enterprise 'AI teammates'/digital twins on identity-based memory architecture for businesses and telcos.

- **Architecture:** Hosted proprietary memory models per identity; closed source; enterprise deployment (including on telecom infrastructure); consumer product effectively deprecated. No local, no export-first, no MCP found.
- **Traction:** Enterprise plan starts $1,000/mo (multiple digital-twin licenses). Private, no recent consumer momentum; the consumer 'personal AI memory' promise quietly died and the company survived by selling twins to companies.
- **Steal:** The original vision doc — a personal model owned by the individual — is Kokoro's pitch; Personal.ai proved the demand narrative but couldn't deliver it as hosted SaaS economics.
- **Avoid:** Per-user model training as the architecture: expensive, opaque, and forced the retreat upmarket. When consumer economics failed, users' 'personal AIs' became enterprise inventory — custody risk again.
- **Sources:** https://pitchbook.com/profiles/company/439218-46 · https://pricingsaas.com/companies/personalai · https://tekpon.com/software/personal-ai/reviews/

### Dot (New Computer) — DEAD — threat: low

Personalized AI companion/confidante iOS app (Sam Whitmore, Jason Yuan) that built a living memory of you through conversation. Launched Jun 2024, shut down Oct 5, 2025 — founders cited diverging visions; users publicly grieved losing 'a friend'.

- **Architecture:** Hosted, closed, memory locked inside the app; on shutdown users got a window to download data. Companion framing, no owned canon, no agent surface.
- **Traction:** Dead. Shipped 16 months. Notable mostly for the emotional dependency it revealed and the total loss of accumulated 'memory' at wind-down.
- **Steal:** Proof that people form real attachment to a system that remembers them — the retention force behind a world model is emotional, not utilitarian. Their wind-down (advance notice + data download) is the ethical minimum bar.
- **Avoid:** Memory that exists only inside a company's runtime: when the company dies, the relationship and the record die. Companion-first framing also invited the AI-safety scrutiny wave of late 2025.
- **Sources:** https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down · https://finance.yahoo.com/news/personalized-ai-companion-app-dot-192747816.html · https://futurism.com/ai-dot-companion-controversy

### Bee (Amazon) — ACQUIRED — threat: low

$49.99 AI wristband that listens to your conversations all day and produces summaries, to-dos, and daily insights. Acquired by Amazon Jul 2025; at CES 2026 presented under Devices & Services with email/calendar voice actions and 'no stored audio' processing.

- **Architecture:** Cloud processing under Amazon; audio-derived text retained, raw audio not stored (claimed); zero user ownership story; eight-person team folded into the Alexa org. The capture endpoint for your spoken life is now a $50 big-tech peripheral.
- **Traction:** Acquired (terms undisclosed). Still sold and actively developed under Amazon as of Jan 2026 — unlike Limitless, the product survived its acquisition.
- **Steal:** $50 price point proved ambient capture hardware is a commodity — Kokoro should treat wearables as ingestion sources (import their exports) rather than compete on capture hardware. Daily insight cards are a good digest pattern.
- **Avoid:** The trust problem is unsolvable at Amazon: an always-listening device feeding a hosted profile is exactly the counter-positioning gift — 'same capture, but the transcript lands in a queue on your disk'.
- **Sources:** https://www.cnbc.com/2025/07/22/amazon-ai-bee-wearable.html · https://techcrunch.com/2026/01/12/why-amazon-bought-bee-an-ai-wearable/ · https://www.forbes.com/sites/andrewwilliams/2026/01/12/amazon-on-the-future-for-50-ai-wearable-that-listens-to-conversations/

### Fabric (fabric.so) — threat: low

AI-native 'second brain' consumer app: one workspace for notes, files, bookmarks, meetings, recordings; AI auto-organizes (no folders/tags), browser extension + mobile capture.

- **Architecture:** Hosted cloud, closed source, auto-magic organization with no review step, LLM mandatory, no MCP/agent surface found, no local-first or export-first story.
- **Traction:** Claims 300K+ users, 4.7-star ratings; free plan + Premium from $8/mo; actively developed through 2025-2026. Real but modest consumer traction.
- **Steal:** Capture ergonomics: extension + mobile + drag-anything ingestion with zero-decision saving is the smoothest capture funnel in the consumer set.
- **Avoid:** 'AI organizes everything for you' with no owner control produces a pile, not a canon — retrieval demos well, trust never compounds, and there's no agent story to grow into.
- **Sources:** https://apps.apple.com/us/app/fabric-ai-notes-files-ideas/id6449003046 · https://aiblogfirst.com/fabric-so-review/ · https://www.primeproductiv4.com/apps-tools/fabricso

**Category lessons:**
- Custody is the category's fatal flaw and Kokoro's whole wedge: within 14 months the three deepest personal-capture products were acquired or killed (Rewind/Limitless -> Meta with region cutoffs and a data-deletion countdown; Bee -> Amazon; Dot dead with users grieving). Hosted memory dies with the vendor; a markdown canon on the owner's disk cannot be acquired out from under them.
- Nobody in the hosted set has a review gate. The spectrum runs from auto-magic piles (Fabric, mymind, Mem 1.0 — trust never compounds) to manual ontology labor (Capacities, Tana — enthusiast ceiling). Staged proposals promoted by the owner is an empty quadrant: system drafts structure, human ratifies canon. Superseded 2026-09-02, see `docs/decision-log.md` C8 and D10: the owner review gate is no longer a claim anywhere; the restated moat is autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness.
- MCP became the category's agent surface in 2025-2026 (Reflect shipped an MCP server Mar 2026, supermemory ships one, Mem has a Claude connector, Notion agents read/write MCP, Granola sells 'enterprise context'). Kokoro's MCP read-only endpoint rides an established rail — it is table stakes, and sensitivity gating + read-only is the differentiated part.
- Traction reality check: immediate-artifact capture wins and abstract 'memory' loses. Granola (great notes today, memory as side effect) went $250M -> $1.5B in ten months; Mem burned $28.6M on 'self-organizing memory' and hasn't raised since 2022; Personal.ai fled to $1,000/mo enterprise. Kokoro onboarding must deliver a same-day artifact (searchable digest, daily brief), letting canon accrue as the by-product.
- Money now flows to memory-as-infrastructure for agents, not memory-as-app for humans (supermemory ~$29M, Mem0 $24M, both API-first). The demand pull Kokoro should market into is 'give your agents trustworthy context' — but as inspectable owned canon instead of a black-box hosted vector store.
- Personal-tier pricing gravity is $6-20/mo everywhere in this category, and metering the memory itself (Mem's capped free chats, Notion's agent credits) reads as hostage-taking and generates resentment. For open-source Kokoro: never meter recall; charge (if ever) for convenience layers like managed sync or hosted inference.
- Privacy sells even when shallow — mymind charges for 'private', Granola won by removing the visible bot, Reflect's E2E supports no-free-tier pricing and profitability on a 3-person team. Not one hosted player can claim zero phone-home or a deterministic no-LLM floor; that claim is unoccupied and legible, and Reflect proves a tiny profitable team can hold trust positioning without VC scale.
- Two independent players converged on Kokoro's core thesis from inside the cloud: Mem 2.0 markets 'memory lives in familiar notes, not an opaque chat history' and Notion stores agent memory as ordinary readable pages. The industry is discovering that memory must be human-readable documents — Kokoro just completes the argument by making them owner-custodied files with a promotion gate. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)


## Agent-memory infrastructure

### Khoj — threat: medium

Self-hostable 'AI second brain' (YC S23): chat/RAG over your docs (PDF, Markdown, org-mode, Notion, Word) plus web search, custom agents, scheduled automations. As of mid-2026 pushing a 2.0 beta and spinning off 'Pipali', an open-source AI coworker that runs on your computer — a drift from second-brain search toward agent/assistant territory.

- **Architecture:** AGPL-3.0. Dual cloud (app.khoj.dev) / self-host via Docker or Python — but the self-host stack is heavy (Django server + Postgres/pgvector), not a single binary. LLM-required product: no deterministic floor; retrieval is embeddings-based. No review gate — ingests everything, answers from an index, never builds a durable canon you own. Clients for Obsidian, Emacs, WhatsApp, browser, phone.
- **Traction:** 36.9k stars / 2.4k forks (Sep 2026), 5,180+ commits, 102 open issues; release 2.0.0-beta.28 Mar 2026. YC S23, ~$500k raised from YC (Tracxn/Crunchbase); no announced follow-on round in 3 years — living on cloud subscriptions + enterprise pitch. Reality: big star count, but the Pipali spinoff signals the second-brain product alone didn't compound into a business.
- **Steal:** Connector breadth as adoption wedge (WhatsApp + Obsidian + Emacs clients drove installs); scheduled automations over your corpus; free-tier cloud as a zero-friction demo of the self-host product.
- **Avoid:** Heavy server stack (Django+Postgres) is the #1 self-hoster complaint — stranger-installable dies there. Index-not-canon: users get answers but never accumulate an owned artifact, so churn is easy. Chat-first framing converges with every assistant and forces the pivot Khoj is now making.
- **Sources:** https://github.com/khoj-ai/khoj · https://www.ycombinator.com/launches/JG4-khoj-your-superhuman-companion · https://tracxn.com/d/companies/khoj/__Bw8lJXayXnil-1jpQmHJMsNfbkd7NHtHqodcnHSpjK4

### Reor — threat: low

DEAD. Private local AI note-taking app ('for high entropy people'): Obsidian-like markdown editor with automatic note linking, semantic search, and local Q&A. Repository archived read-only on March 7, 2026.

- **Architecture:** AGPL-3.0. Electron desktop app; markdown files on disk; Transformers.js embeddings + LanceDB vector store; local LLM via Ollama. Philosophy was explicitly 'AI tools for thought should run models locally by default' — the closest prior art to Kokoro's local-LLM-optional stance, but LLM was load-bearing, not optional.
- **Traction:** 8.6k stars / 527 forks at death. Show HN splash Feb 2024, then a slow two-year fade — thin commits through 2025, archived Mar 2026. Solo-maintainer project that never found a wedge against Obsidian+plugins.
- **Steal:** The positioning language ('runs models locally by default') resonated hard — 8.6k stars on philosophy alone. Auto-surfacing related notes in a sidebar while you write is a good passive-value loop.
- **Avoid:** The whole arc: an AI notes app whose only differentiator is 'local AI' loses to the incumbent editor's plugin ecosystem the moment plugins catch up. Electron + bundled local models = heavy, slow, and always behind Ollama-native tooling. Solo maintainer + no revenue = archive. AI-writes-your-graph with no review step produced link spam users didn't trust.
- **Sources:** https://github.com/reorproject/reor · https://news.ycombinator.com/item?id=39372159

### Logseq — threat: low

Open-source outliner PKM (Roam-style, privacy-first). Spent 2023-2026 on a database-backend rewrite that stalled the file-based app for years; as of 2026 the project has split in two: Logseq OG (original file-based markdown/org app) and Logseq 2.0 'DB version' (SQLite-backed, RTC sync, new mobile), whose first beta 2.0.1 landed July 13, 2026.

- **Architecture:** AGPL-3.0. Clojure/ClojureScript + DataScript. OG: local markdown/org files as truth. DB version: database is truth, files become an export format — a deliberate retreat from plaintext canon, which is exactly the wound that fractured its community. No AI core; plugin API exists. Sync is the paid service.
- **Traction:** 44.7k stars / 2.8k forks, 853 open issues. File-based line effectively frozen (last 0.10.15 beta Dec 2025); DB beta ships with data-loss warnings. Forums full of 'Leaving Logseq' threads citing 4-10 minute load times on ~2k-page graphs and sync crashes; measurable migration to Obsidian/AFFiNE. Raised a $4.1M seed (2021-era); no growth story since.
- **Steal:** Its community proved demand for local-first + privacy-first at scale (44k stars). Property/query system on top of plaintext blocks. The split itself is instructive: they had to keep the files version alive because that's where the trust was.
- **Avoid:** The defining cautionary tale of the category: a multi-year rewrite that moved canon from user-owned files into a database, shipped nothing stable meanwhile, and bled the community. Also: outliner-only data model made every block a row, making performance debt structural. Never make users wait years between stable releases.
- **Sources:** https://github.com/logseq/logseq · https://github.com/logseq/logseq/releases · https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020 · https://github.com/logseq/docs/blob/master/db-version.md

### Obsidian AI plugin ecosystem (Copilot, Smart Connections) — threat: medium

The de facto distribution channel for 'AI over my markdown': Copilot (logancyang) is the #1 Obsidian AI plugin — chat, vault QA, multi-agent, now routing to Claude Code/Codex; Smart Connections (brianpetro) does local-embedding semantic 'related notes' plus Smart Chat. Obsidian itself is closed-core but its plaintext vault is the substrate everyone builds on.

- **Architecture:** Copilot: AGPL-3.0 plugin, local search index on device, BYOK or hosted Brevilabs backend for paid tiers (Copilot Plus $14.99/mo, Believer tier). Smart Connections: moved from MIT to a restrictive 'Smart Plugins License' (source-available, bars competing Obsidian offerings); local embeddings by default, zero API keys, pro plugins gated to supporters (~$20/mo tier appeared 2025). Both write directly into the vault with no staging/review layer; sensitivity gating absent.
- **Traction:** Copilot 7.7k stars / 729 forks, 1,130 commits, active; Smart Connections 5.4k stars / 340 forks, 1,913 commits. Obsidian's commercial success (Sync/Publish) funds the host platform; both plugins converted free users to subscriptions in 2025-2026 with grumbling but survival — the only solo-dev monetizations in this list that worked.
- **Steal:** Local embeddings by default, zero-setup ('install, enable, it just works') is now table stakes. Monetize the hosted convenience (model routing, sync), never the data layer. Passive surfacing of related notes while writing is the retention loop. Ship as a plugin into an existing vault ecosystem for distribution before shipping a standalone app.
- **Avoid:** Mid-flight license flips (Smart Connections MIT→proprietary-ish) permanently taint community goodwill even when revenue-justified. Plugins write AI output straight into the canon vault — users report slop accumulating in notes; no review gate exists anywhere in the ecosystem. Dependence on a closed-core host caps how deep capture can go (no ambient ingestion).
- **Sources:** https://github.com/logancyang/obsidian-copilot · https://github.com/brianpetro/obsidian-smart-connections · https://www.obsidiancopilot.com/en/pricing · https://tryeyrie.com/guide/obsidian-ai/

### SilverBullet — threat: low

Self-hosted 'programmable personal knowledge database': markdown wiki with live preview, wikilinks, a built-in object database + query language over frontmatter/blocks, and Space Lua scripting. Went through a v1→v2 rewrite (2025) that removed features to rebuild on Lua; 2026 focus is indexer robustness/performance (solo dev Zef Hemel, ~2k-page dogfood space).

- **Architecture:** MIT. Server component (now with a Rust backend piece) + PWA client, markdown files ('Spaces') as sole storage, offline-capable. No LLM anywhere in core — a fully deterministic floor: queries, templates, and automation are Lua over plaintext. The closest existing demonstration that 'markdown wiki + queryable structured layer + scripting' works without AI.
- **Traction:** 6.0k stars / 473 forks, 3,637 commits, steady releases through 2026; LWN coverage Aug 2025. No funding, no pricing — pure hobby-scale OSS with a small devoted self-hoster community. Bus factor of one.
- **Steal:** The frontmatter-as-database pattern: every page is both prose and a queryable object, indexed deterministically — this is Kokoro's deterministic floor, already proven. PWA + single self-hosted server is a clean stranger-install story. Space Lua shows users will script their own wiki if the primitives are good. (Superseded in part 2026-09-02, see `docs/decision-log.md` D12: the model-free floor is capture, dedup, the ledger, search, timeline, context, audit and undo; canon writing requires a configured model.)
- **Avoid:** v1→v2 breaking rewrite cost it users and momentum (same disease as Logseq, smaller dose). Solo-maintainer velocity ceiling. No capture story at all — content only exists if you type it, which caps the audience at tinkerers.
- **Sources:** https://github.com/silverbulletmd/silverbullet · https://lwn.net/Articles/1030941/ · https://v2.silverbullet.md/SilverBullet

### Foam — threat: low

VS Code extension for markdown PKM (wikilinks, backlinks, graph view, daily notes, templates) — the 'Roam in VS Code' of 2020. Effectively dormant: still installed, barely developed, README still calls it 'alpha-grade' six years in.

- **Architecture:** MIT. Pure markdown files + GitHub for sync/publish; graph derived deterministically from links. No AI, no server, no capture — an editor-plugin veneer over a folder. Zero phone-home by construction.
- **Traction:** 17.4k stars / 775 forks, but the last releases (vscode 0.44.5/0.44.6) shipped September 2024 — two years stale as of Sep 2026. Community contributions trickle; no funding, no monetization ever attempted.
- **Steal:** Proof that 'your notes are just a git repo of markdown' is a durable, trust-generating pitch — Foam's data outlives Foam. Orphan/placeholder detection is a nice canon-hygiene primitive Kokoro's review gate could adopt. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** Stars are archaeology: 17.4k stars, dead cadence. Living inside someone else's editor means you never own the experience or the roadmap, and 'alpha forever' kills stranger trust. No sustainability plan = slow fade even without drama.
- **Sources:** https://github.com/foambubble/foam · https://github.com/foambubble/foam/releases

### ActivityWatch — threat: low

Open-source automated time tracker: local daemon + watchers (active window, AFK, browser, editors) logging events to a local server with REST API and dashboard. The OG passive-capture-stays-local project, volunteer-run by the Bjäreholt brothers since 2016.

- **Architecture:** MPL-2.0. Fully local: aw-server (Python; Rust rewrite perpetually 'planned'), watcher plugin architecture, bucket/event/heartbeat data model, query API. No LLM, no MCP, no synthesis layer in core — deterministic capture with zero canon: raw events pile up and the user must extract meaning manually.
- **Traction:** 18.8k stars / 1.0k forks; donation-funded, volunteer-paced. Issues open into 2026 but release cadence is glacial (changelog thins out after v0.13-era; forum threads literally ask 'is anything coming?'). Alive, respected, stagnant.
- **Steal:** The watcher architecture is the best open blueprint for Kokoro's capture edge: small per-source daemons, heartbeat dedup, append-only local event buckets, documented REST/query API. Its decade of survival proves local passive capture has durable demand.
- **Avoid:** Capture without synthesis is a data graveyard — AW's own community's chief complaint is that data goes in and insight never comes out. Volunteer/donation funding = 10 years to not ship the Rust server. Missing the 2025-2026 MCP/agent wave left its data siloed just as it became valuable.
- **Sources:** https://github.com/activitywatch/activitywatch · https://activitywatch.net/ · https://docs.activitywatch.net/en/latest/changelog.html · https://forum.activitywatch.net/t/i-want-to-know-about-activitywatchs-future-development-any-exciting-updates-coming/4178

### screenpipe — threat: high

YC S26 'Open Computer History': 24/7 local screen + mic capture (event-driven screenshots + accessibility trees, local Whisper transcription with speaker ID) feeding AI agents via MCP and a 'pipes' plugin system. Formerly mediar-ai/screenpipe (MIT); founder also spun the automation half into Mediar/terminator-rs ($2.8M raised Jul 2025, LG in production 2026). On June 9, 2026 screenpipe itself flipped MIT → Screenpipe Commercial License (source-available, paid for any commercial/production use).

- **Architecture:** Source-available (no longer OSS). Local-first: SQLite+FTS5, ~5-10GB/month, 'telemetry optional'. MCP server into Claude Desktop/Cursor/VS Code. Notably ships deterministic YAML permission gating (allow-apps / deny-windows / time-range) enforced at OS level — the only product in the category with sensitivity gating. No canon and no review: history is the product, an ever-growing searchable index, not a curated world model.
- **Traction:** 21.4k stars / 2.2k forks / 13k commits; 'hundreds of thousands of installs' claimed pre-flip. YC S26; subscriptions $25/mo standard, $50/seat pro, $150/seat enterprise (SSO, MDM). The license flip generated real backlash and an 'alternatives' cottage industry — but the company is funded and shipping.
- **Steal:** Event-driven capture (record on state change, not continuously) — directly applicable to Kokoro's desktop A/V edge and its queue costs. Deterministic, declarative permission gating as a marketed feature, not fine print. MCP-as-context-server is the proven agent hookup. Their positioning against Rewind/Limitless/MS Recall maps the demand.
- **Avoid:** The rug-pull arc: build 20k stars on MIT, flip to commercial once funded — Kokoro must fix license + monetization posture publicly on day one. Also: 5-10GB/month of unreviewed capture with no promote-to-canon step means the archive's value decays into sludge; retention/summarization is bolted on via 'pipes' rather than designed in. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/screenpipe/screenpipe · https://screenpipe.com/blog/screenpipe-license-update · https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md · https://www.mediar.ai/t/mediar-company

### Anytype — threat: medium

VC-backed local-first 'digital brain': object/block knowledge base (databases, kanban, calendar) with zero-knowledge encryption and P2P/self-hostable sync (any-sync). 2025-2026: shipped a public API + official MCP server, launched Anytype for Business (~€20/editor/mo) — drifting from personal PKM toward sovereign team workspace.

- **Architecture:** App under 'Any Source Available License 1.0' (not OSI); any-sync protocol is MIT. Local-first CRDT storage in a custom object format — NOT plaintext; markdown is an export, canon lives in Anytype's own store. Free for local-only use; paid tiers ($5/$10/$20/mo) sell backup+sync. Official MCP server (@anyproto/anytype-mcp) gives agents read/write over the local API — write access, no review gate, sensitivity gating absent.
- **Traction:** $13.4M Series A led by Balderton (Aug 2023; $13.5-29M total per trackers), ~43 employees; anytype-ts 8.7k stars / 32.7k commits, actively developed. Early-stage revenue, no disclosed user counts; pivoted to Business plans in 2026 to find a model.
- **Steal:** any-sync's local-first encrypted multi-device sync is the best open protocol work in the category if Kokoro ever needs device sync. Shipping an official MCP server made agent access a headline feature. 'App stays free local-only, pay for sync' is a clean monetization line that doesn't taint the local promise.
- **Avoid:** Custom binary object store = permanent export anxiety; every comparison thread dings Anytype on 'can I get my data out as files?' — plaintext canon is the counter-position. Non-OSI license caps community contribution. $13M+ and 43 people to reach roughly the same star count as a solo dev's plugin shows capital doesn't buy trust in this category.
- **Sources:** https://github.com/anyproto/anytype-ts · https://github.com/anyproto/anytype-mcp · https://business.anytype.io/ · https://developers.anytype.io/docs/examples/featured/mcp/

### Basic Memory (added) — threat: high

Local-first AI knowledge base built MCP-first: Claude/Cursor/Codex read AND write structured Markdown notes (entities, observations, wikilinks) forming a knowledge graph that persists across AI sessions. The closest architectural neighbor to Kokoro's canon+MCP layer, minus capture and minus a review gate. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)

- **Architecture:** AGPL-3.0, Python. Plain Markdown files on disk as truth, SQLite index, semantic search + reranking, MCP server as the primary interface; Obsidian-compatible vault. Crucially the AI writes directly into canon — 'bidirectional, conflict-aware sync' instead of staged proposals reviewed by the owner. LLM-centric by design (it exists to serve LLM sessions). Cloud tier $15/mo (beta price lock) for sync/hosted access.
- **Traction:** 3.8k stars / 270 forks, 1,869 commits, active through 2026; small team (Basic Machines). Real devoted users ('I don't code without Basic Memory anymore') but niche: adoption rides the Claude-power-user wave, no funding announced.
- **Steal:** Entity/observation/relation schema layered on ordinary Markdown — a ready-made pattern for Kokoro's canon page structure. MCP-first go-to-market: it acquired users purely by being the memory MCP people paste into Claude config. Obsidian compatibility for free UI.
- **Avoid:** Unreviewed AI writes into canon is its known failure mode — users report graph pollution and duplicate entities; Kokoro's OWNER-review gate is the direct answer. No capture pipeline means the knowledge base only knows what you told the chatbot. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/basicmachines-co/basic-memory

### OpenRecall (added) — threat: low

MOSTLY DEAD. Community open-source clone of Microsoft Recall / Rewind: periodic screenshots + OCR + semantic keyword search, all local. Spiked on the 2024 Recall backlash, then stalled — activity trails off in early 2025.

- **Architecture:** AGPL-3.0, Python 3.11. Local screenshot capture, OCR text extraction, optional encryption, local semantic search; no MCP, no agents, no synthesis, no canon. Deterministic pipeline, LLM-free — but also value-free beyond raw search.
- **Traction:** 2.9k stars / 195 forks on only ~90 commits — a hype-to-code ratio of a protest project, not a product. Maintenance 'moderate' at best since early 2025; community lives in Discord/Telegram remnants.
- **Steal:** Its birth proves the market: the instant Microsoft announced ambient capture, thousands starred the 'same thing but local and auditable' repo within weeks. Kokoro's zero-phone-home stance taps the identical nerve.
- **Avoid:** Screenshot capture with nothing downstream (no timeline product, no summarization, no agent surface) retains nobody — the wedge must include what the capture becomes. Protest-fork energy without a sustaining maintainer evaporates in under a year.
- **Sources:** https://github.com/openrecall/openrecall

### Dendron (added) — threat: low

DEAD. VS Code-based hierarchical PKM ('the tool that grows as you do'): schema-validated, dot-notation-hierarchy Markdown notes with refactoring tools. Active development ceased February 2023 (announced on Discord); maintenance-only since. Founder Kevin Lin cited family reasons and now works at OpenAI 'building tools of thought with AI'.

- **Architecture:** Apache/CC-licensed OSS, markdown files as truth, deterministic schema system that validated note structure against user-defined schemas — the only product in this list that had a real notion of enforced canon shape. VS Code host; no AI, no capture.
- **Traction:** Reached ~100k users and a Seattle-startup seed before winding down; repo frozen since 2023. The category's cleanest proof that users alone don't sustain an OSS engine.
- **Steal:** Note schemas: machine-checked structure over plaintext canon is exactly what a review gate needs to validate promotions deterministically. Hierarchical naming (project.area.topic) scaled to tens of thousands of notes where flat vaults choke. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** 100k users + zero durable business model + bus factor of ~1 = maintenance mode. Hosting inside VS Code capped the audience at developers and left no monetizable surface. Winding down quietly on Discord (not the repo/site) stranded users — sunset loudly or don't.
- **Sources:** https://github.com/dendronhq/dendron · https://www.dawidsblog.com/posts/tech_pkm_tools/ · https://kevinslin.com/

**Category lessons:**
- Stars are archaeology, not traction: Foam (17.4k, last release Sep 2024), Reor (8.6k, archived Mar 2026), OpenRecall (2.9k on 90 commits), Logseq (44.7k, community bleeding) all outrank healthier products. Judge this category by release cadence, bus factor, and whether the maintainer eats — and expect Kokoro to be judged the same way.
- Plaintext markdown canon is the trust moat. Both projects that moved truth out of user-owned files into a database (Logseq DB rewrite, Anytype's object store) paid in community trust and export anxiety; every survivor (Obsidian ecosystem, SilverBullet, Foam's corpse, Basic Memory) keeps files as truth. Kokoro's markdown-wiki-you-own is the single most defensible stance in the category — never compromise it, even for performance.
- Multi-year breaking rewrites kill momentum in this category specifically, because users' accumulated notes are hostage: Logseq (3 years, split product), SilverBullet v1→v2 (feature removals, churn). Ship additive; migrate never-or-instantly.
- The license flip is now the expected monetization arc (screenpipe MIT→commercial Jun 2026, Smart Connections MIT→Smart Plugins License) and each flip spawned an 'alternatives' industry. Kokoro should publish its license + how-money-works posture on day one; 'free local-only, pay for sync/hosted' (Anytype, Obsidian, Basic Memory) is the only pattern that monetized without backlash.
- Capture without a synthesis/review layer is a data graveyard: ActivityWatch (10 years of raw events, users beg for insight), OpenRecall (screenshots, then nothing), screenpipe (5-10GB/month searchable sludge). NOBODY in this category has a staged-proposal → owner-review → promote-to-canon gate. That review gate plus sensitivity gating is Kokoro's genuinely open lane Superseded 2026-09-02, see `docs/decision-log.md` C8 and D10: the owner review gate is no longer a claim anywhere; the restated moat is autonomous, provenance-total, reversible canon with conversational correction, zero phone-home, any harness. The open lane is autonomy with receipts plus sensitivity gating, not a gate. — the nearest neighbors either capture-without-canon (screenpipe, ActivityWatch) or canon-without-capture (Basic Memory, SilverBullet, Obsidian plugins).
- MCP became the standard agent surface in 2025-2026 (screenpipe, Anytype, Basic Memory all ship official servers; Basic Memory acquired its whole user base through it). MCP presence is table stakes; Kokoro's differentiators are read-only + sensitivity gating — steal screenpipe's deterministic YAML allow/deny permission model as the reference implementation, and note that unreviewed MCP write access (Basic Memory, Anytype) demonstrably pollutes graphs. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Solo-maintainer engines define the failure distribution: Dendron (100k users, wound down), Reor (archived), Foam (dormant), SilverBullet and Smart Connections (alive but bus-factor 1). Stranger-installable also means boring to install — Khoj's Django+Postgres stack is the canonical complaint; single-binary or one docker compose is the bar.
- Chat-RAG 'second brain' framing converges into generic assistants and forces pivots (Khoj → Pipali AI coworker; Reor died on it). The durable wedge is the owned data substrate agents plug into, not the chat UI on top. Kokoro's 'world model your agents query' framing is on the right side of that convergence.
- Local-first demand is proven and periodically re-ignited by platform scares (Microsoft Recall backlash minted OpenRecall's 2.9k stars in weeks; screenpipe positioned against Rewind/Recall to 21k stars; Anytype raised $13.4M on data sovereignty). The audience exists and re-mobilizes on every privacy news cycle — time launches to those cycles.
- An LLM-optional deterministic floor is rare and viable: SilverBullet (Lua + frontmatter queries), ActivityWatch, Dendron's schemas all delivered real value with zero LLM. Products where the LLM is load-bearing (Reor, Khoj) aged with model churn and API costs; the deterministic floor also future-proofs the trust story for stranger installs. (Superseded in part 2026-09-02, see `docs/decision-log.md` D12: the model-free floor is capture, dedup, the ledger, search, timeline, context, audit and undo; canon writing requires a configured model.)


## Capture and connector layer

### Composio — threat: low

VC-backed (~$120M valuation, Lightspeed Series A) integration platform exposing 1,089 app toolkits / 20k+ tools to AI agents through a single MCP endpoint, with managed OAuth. Dev-infra, not a personal product. As of Aug 2026: free tier 100K tool calls/mo, $29/mo Pro, custom Enterprise — and a controversial change putting self-managed credentials behind a $599/mo tier (existing customers grandfathered to Dec 31 2026).

- **Architecture:** Pure cloud. Credentials live with Composio by default (managed OAuth apps); bringing your own keys is being monetized upward. No local option, no plaintext store, no review gate — it is plumbing for agents, the opposite of zero-phone-home. MCP-native.
- **Traction:** Aug 2026: 1,089 toolkits, ~$120M valuation (Feb 2025), used across LangChain/CrewAI ecosystems. Real dev adoption but pricing-change backlash in Aug 2026.
- **Steal:** The single-MCP-endpoint pattern (one server, tool search inside, not one server per app) and trigger/webhook events as first-class alongside actions. Their taxonomy of 'toolkit = one app' is clean.
- **Avoid:** Centralized credential custody as the business model — the $599/mo self-managed-credentials wall is exactly the move that makes privacy-minded users flee. Kokoro's owner-owned credentials must be the headline, but note WHY Composio charges for the alternative: self-managed OAuth setup is genuinely painful — Kokoro must make it not painful or stranger-install dies at the first connector.
- **Sources:** https://composio.dev/pricing · https://www.scalekit.com/blog/composio-pricing-change · https://composio.dev/content/best-mcp-gateway-for-developers

### Readwise (+Reader) — threat: medium

Bootstrapped read-later + highlight-sync service: captures highlights from Kindle/articles/PDFs/RSS/newsletters, resurfaces via spaced repetition, and exports everything to Obsidian/Notion/Roam/Markdown. ~$14M ARR, ~28 employees (2026), no free tier ($5.59-$12.99/mo). Grew further off the July 2025 Pocket shutdown refugee wave.

- **Architecture:** Cloud service, but the most export-friendly one alive: official Obsidian plugin with templated Markdown export, public highlights API that became the de facto capture standard for PKM. No local-first, no review gate (everything auto-syncs), LLM features (Ghostreader) optional add-ons.
- **Traction:** ~$14M ARR 2026, bootstrapped, profitable, loyal PKM user base; the default answer to 'where do my highlights go'. Dated: Apr 2026 employee count, post-Pocket growth documented through 2025-26.
- **Steal:** The templated Markdown export pipeline into a vault the user owns — Readwise proved people will PAY monthly specifically for reliable capture-into-my-Markdown. Also: bootstrapped-niche economics beat VC in this category. Kokoro should read Readwise's export format and offer a Readwise importer day one.
- **Avoid:** Cloud custody of the canon — Readwise users' actual archive lives on Readwise servers; the vault is a mirror. And no distillation: highlights pile up, resurfacing is spaced-repetition roulette, never a curated world model.
- **Sources:** https://readwise.io/changelog/obsidian-export · https://docs.readwise.io/readwise/docs/exporting-highlights · https://blog.readwise.io/why-were-bootstrapping-readwise/ · https://www.fueler.io/blog/readwise-usage-revenue-valuation-growth-statistics

### screenpipe (Mediar / YC S26) — threat: high

Rust local recorder capturing screen (accessibility tree + OCR fallback), audio (Whisper), mic continuously into a local SQLite/FTS5 store; ships an MCP server so Claude/Cursor query your computer history; 'pipes' = markdown-defined scheduled AI agents with data-permission frontmatter. 2026 pivot emphasis: team/enterprise deployment with admin-controlled, OS-enforced per-pipe AI data permissions.

- **Architecture:** Local-first by default (SQLite, ~5-10GB/mo, event-driven capture), cloud sync/AI optional, MCP read access native. Source-available for personal use, commercial license required; signed app phones home PostHog/Sentry analytics unless disabled. Subscription: $25/mo standard, $50 Pro, $150 enterprise.
- **Traction:** 21.4k stars, 2.2k forks, 130+ contributors, YC S26, active weekly releases through Aug 2026. The strongest live project in this category.
- **Steal:** Event-driven capture (record only on meaningful change — solves the storage swamp), accessibility-tree-first extraction with OCR fallback, MCP server as the agent interface, and declarative per-source data permissions enforced below the prompt layer — the closest thing anyone has to Kokoro's sensitivity gating.
- **Avoid:** No canon: it is a searchable timeline, not a world model — nothing is ever distilled, reviewed, or promoted, so it stays a haystack agents grep. Also its license retrofit (open → source-available + subscription) generated community friction; and 'local-first' with default telemetry undermines the zero-phone-home claim. Kokoro's review-to-canon gate is exactly what screenpipe lacks. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://github.com/mediar-ai/screenpipe · https://screenpipe.com/blog/rewind-ai-alternative-2026 · https://github.com/screenpipe/screenpipe

### Beeper / Texts (Automattic) — threat: medium

Unified messaging app (WhatsApp, Signal, Telegram, iMessage-adjacent, Slack, Discord, LinkedIn, etc. — 12 networks). Automattic paid $50M for Texts (2023) + $125M for Beeper (2024), merged them, relaunched July 2025 with an on-device bridge architecture and paid tiers: free (5 accounts), Plus $9.99/mo (10 accounts, scheduling, transcription), Plus Plus $49.99/mo unlimited.

- **Architecture:** Post-2025 relaunch: bridges run on-device, E2EE preserved, Matrix underneath. Self-hosting exists via bridge-manager (bbctl) — self-hosted bridges are free and don't count against limits — but Beeper clients still require a Beeper account; the old fully-self-hosted repo is archived. No canon, no memory layer, no MCP.
- **Traction:** $175M of Automattic acquisitions, ~30-person team, relaunched Jul 2025, active through 2026. Real but strategically captive product.
- **Steal:** The on-device bridge model is Kokoro's best capture path for messaging: mautrix bridges (Beeper's own open-source stack) are the proven way to ingest WhatsApp/Telegram/Signal without owning protocol reverse-engineering. Lean on that ecosystem, never build bridges.
- **Avoid:** The maintenance economics: 12 networks require a funded 30-person team fighting protocol changes forever. A solo OSS project offering 'connect WhatsApp' as a first-party promise will drown — ship connectors as adapters over existing bridges/exports and say so honestly.
- **Sources:** https://github.com/beeper/self-host · https://developers.beeper.com/bridges/self-hosting/ · https://blog.beeper.com/2025/07/16/the-new-beeper/ · https://techcrunch.com/2025/07/16/beepers-all-in-one-messaging-app-relaunches-with-an-on-device-model-and-premium-upgrades/ · https://help.beeper.com/en_US/beeper-plus/account-limits-everything-you-need-to-know

### Omnivore (DEAD) — threat: low

Open-source read-it-later app (web/iOS/Android, Obsidian/Logseq plugins, full-text search, open API), launched ~2022, acqui-hired by ElevenLabs Nov 1 2024. Service shut down Nov 15 2024 — users got 14 days to export before permanent deletion. No read-only mode, no archive.

- **Architecture:** Open-source code but cloud-hosted service and cloud data; self-hosting was technically possible but so operationally heavy almost nobody ran it. The repo being open did not save a single user's data.
- **Traction:** Dead. Loyal dev/Obsidian following at peak; team now builds ElevenReader.
- **Steal:** Its funeral: every alternative (Wallabag, Karakeep, Readwise) shipped an Omnivore importer within weeks. Kokoro should treat dead-product import (Omnivore/Pocket export formats) as free acquisition. Also steal its Obsidian plugin UX — capture landing directly in the vault was the loved feature.
- **Avoid:** The core lesson: 'open source' without local-first data is a false promise — VC-funded free service + no revenue = acqui-hire + 14-day data window. Kokoro's pitch ('your canon is Markdown on your disk; the project dying costs you nothing') is the direct answer to this trauma, and the audience remembers it vividly.
- **Sources:** https://www.creativerly.com/the-exit-us-of-omnivore-from-open-source-to-ai-vc-money/ · https://molodtsov.me/2024/10/omnivore-is-dead-where-to-go-next/ · https://alternativeto.net/news/2024/10/elevenlabs-acquires-omnivore-to-boost-elevenreader-app-for-enhanced-reading-experience

### Karakeep (ex-Hoarder) — threat: medium

Self-hostable bookmark-everything app (links, notes, images, PDFs, RSS auto-hoarding, full-page archival) with optional LLM auto-tagging/summarization/OCR. Renamed from Hoarder in 2025 over a naming conflict. The healthiest OSS project in the capture space.

- **Architecture:** Docker/K8s self-host, NextJS + tRPC + Drizzle + Meilisearch (full-text and semantic search), Puppeteer crawling. LLM genuinely optional and pluggable (OpenAI, Ollama local, Gemini) — a working deterministic floor. CLI + agent skills shipped; managed cloud (cloud.karakeep.app) funds development. Importers for Pocket, Omnivore, Chrome, Linkwarden.
- **Traction:** 28.7k stars, 1.5k forks, 192 contributors, 2,222 commits, active through 2026; grew hard off Pocket/Omnivore deaths.
- **Steal:** Proof that 'self-hosted + optional local LLM + eat-the-dead-products'-importers' finds a big audience fast. Steal its onboarding (single docker-compose to useful), its Ollama-optional AI posture, and its browser-extension + mobile capture surface.
- **Avoid:** It stops at storage: everything captured is kept, auto-tagged, searched — never reviewed, distilled, or promoted, and there's no notion of the data representing YOU (no identity/world model, no sensitivity tiers). Also 609 open issues shows the support load a popular self-hosted app carries.
- **Sources:** https://github.com/karakeep-app/karakeep · https://selfhostsetup.com/posts/karakeep-ai-bookmark-manager/

### Wallabag — threat: low

The grandfather self-hosted read-it-later (open source, PHP/MySQL), 10+ years old, v2.6.14 (Oct 2025), still maintained with community events into 2026. Paid hosted option at wallabag.it.

- **Architecture:** Fully self-hosted, no AI at all, no tracking, article extraction + clean reading, API + RSS 'open ecosystem', Pocket/Omnivore/Instapaper importers, CSV/e-reader exports.
- **Traction:** Modest but immortal: slow release cadence, small team, sustained by hosting revenue and community. Outlived Pocket and Omnivore.
- **Steal:** Longevity economics: tiny scope + boring stack + small hosted service = a decade of survival with zero funding. Also its e-reader/RSS egress — canon should be consumable everywhere.
- **Avoid:** PHP-era self-hosting friction (Composer, MariaDB, reverse proxy) is why Karakeep ate its growth — stranger-installability decided the winner. Kokoro's install path must be one command or it becomes Wallabag: respected, recommended, rarely chosen.
- **Sources:** https://wallabag.org/ · https://dasroot.net/posts/2026/01/self-hosted-read-it-later-wallabag-alternatives-2026/

### Fabric.so — threat: low

London startup (2022): 'AI workspace that thinks with you' — drive + notes + infinite canvas + semantic search over files/emails/media + named AI agents, 50+ app connections. Raised only ~$7.75M total; PitchBook shows 4 employees in 2026.

- **Architecture:** Pure cloud, proprietary, everything uploaded to their servers for semantic indexing. No local option, no export-first posture, LLM mandatory (it IS the product).
- **Traction:** Weak: 4 employees, sub-$8M raised across 5 rounds, mixed app-store reviews (upload failures), broad 20-professions positioning that suggests no ICP found. Alive but drifting — classic pre-zombie profile.
- **Steal:** Almost nothing architecturally; its 'death to organizing' marketing insight is real though — users hate filing. Kokoro's answer (agents propose, owner approves) is the credible version of that promise. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Avoid:** The 'AI second brain in our cloud' positioning graveyard: beautiful demos, horizontal pitch, no wedge, and users won't pour their whole digital life into a 4-person startup's cloud. Validation that trust, not features, is the bottleneck Kokoro's local-first stance solves.
- **Sources:** https://fabric.so/ · https://pitchbook.com/profiles/company/523109-71 · https://tracxn.com/d/companies/fabric/___P6xQGlrKCcbuhvHufcpOZAKc8VjaLXBzF9uhXnNCvI/funding-and-investors

### Rewind → Limitless (DEAD as independent) — threat: low

The cautionary arc of this whole category: Rewind (2022, a16z, ~$45M total) recorded your Mac screen/audio into searchable local history → pivoted 2024 to the $99 Limitless Pendant (conversations only) → Meta acquired the company Dec 5 2025, killed pendant sales immediately, absorbed the team into Reality Labs, and remotely disabled the Rewind Mac app's screen/audio capture on Dec 19 2025.

- **Architecture:** Rewind stored data locally on-Mac but the app was proprietary and cloud-activated — which is why capture could be switched off remotely at acquisition. Limitless was cloud-processed with a 'confidential cloud' pitch. Neither had a canon or review layer; both were raw archives.
- **Traction:** Dead. Existing pendant owners get free service through 2026, then Meta's roadmap. Screenpipe openly harvests its refugees.
- **Steal:** Two proofs: (1) real demand exists for total capture (Rewind hit strong early revenue and a16z money on the exact 'search your life' promise); (2) the pivot lesson — narrowing capture to conversations was 'more useful and easier to explain'. Scope beats totality for adoption.
- **Avoid:** Proprietary local-first is not local-first: a kill switch flipped by an acquirer ended every user's capture overnight. This is Kokoro's single best evangelism story for open source + plaintext + no phone-home.
- **Sources:** https://techcrunch.com/2024/04/17/a16z-backed-rewind-pivots-to-build-ai-powered-pendant-to-record-your-conversations · https://winbuzzer.com/2025/12/05/meta-acquires-ai-wearables-startup-limitless-kills-pendant-sales-and-sunsets-rewind-app-xcxwbn/ · https://www.hedy.ai/post/meta-acquires-limitless-ai-privacy/ · https://rewind.ai/what-happened-to-rewind/

### Bee (Amazon) — threat: medium

$49.99 always-listening wrist wearable + $19/mo subscription: transcribes your day, auto-generates summaries, to-dos, 'insights and patterns'. Acquired by Amazon July 2025; post-acquisition (Jan 2026) added email/calendar connections, voice notes, daily insights — becoming a personal-context feeder for Amazon's assistant ambitions.

- **Architecture:** Fully cloud: audio → Bee/Amazon servers → summaries. No local processing, no export-first canon, no review gate (todos and 'facts' about you are generated autonomously — a known trust complaint). Developer docs exist (docs.bee.computer) but it's an Amazon data funnel now.
- **Traction:** Amazon-scale distribution potential; $50 price point commoditized the category. Privacy-minded users publicly churned at acquisition. Dated: TechCrunch Jan 12 2026 feature coverage.
- **Steal:** The capture-ergonomics bar: $50, zero-config, all-day battery, and 'connections' (email + calendar fused with conversation memory) — Bee validated exactly Kokoro's multi-source fusion, just with the wrong custody model. Also its daily-recap surface is a good UX pattern for review queues. (Kizuki-side note: the staging queue feeds the receipted writer, not a person; superseded framing 2026-09-02, see `docs/decision-log.md` D9 and D10.)
- **Avoid:** Autonomous fact-generation about the owner with no approval step — Bee's hallucinated to-dos and creepy 'insights' are the anti-pattern Kokoro's staged-proposal gate exists to fix. And obviously: Amazon custody of your life audio is the fear Kokoro monetizes. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- **Sources:** https://www.bee.computer/ · https://techcrunch.com/2025/07/22/amazon-acquires-bee-the-ai-wearable-that-records-everything-you-say/ · https://techcrunch.com/2026/01/12/why-amazon-bought-bee-an-ai-wearable/

### Omi (Based Hardware, ex-Friend) — threat: medium

$89 open-source (MIT) AI pendant + apps: records conversations and screen, real-time transcription, summaries, action items, chat-with-memory; own app store with 250+ community apps. Renamed from 'Friend' after friend.com trademark conflict (the separate friend.com necklace by Avi Schiffmann is a different, widely mocked cloud companion product).

- **Architecture:** Open-source everything (firmware, Flutter apps, Python/FastAPI backend, hardware designs) — but the default data path is CLOUD: audio routes through their backend using Deepgram ASR, Firebase storage, Redis. 'You can self-host or store locally' is possible-in-principle, not the shipped default. No canon, no review gate.
- **Traction:** 13.4k stars, 2.2k forks, 35k commits, claims 300k+ users, 9k Discord members (Jan 2026), 250+ apps. Real dev community; consumer traction claims are self-reported.
- **Steal:** The dev-platform playbook: open hardware + app store made hackers evangelists and generated the connector ecosystem for free. Kokoro's MCP surface + skill/plugin story can copy this dynamic without hardware.
- **Avoid:** 'Open source' as brand while defaulting to Deepgram + Firebase — the community notices, and it forfeits the trust position. If Kokoro ever takes audio, the deterministic local floor (whisper.cpp-class) must be the default, not the footnote.
- **Sources:** https://github.com/BasedHardware/omi · https://techcrunch.com/2025/01/08/omi-a-competitor-to-friend-wants-to-boost-your-productivity-using-ai-and-a-brain-interface · https://grokipedia.com/page/Omi_wearable_AI

### Pocket (DEAD — added) — threat: low

The category's mass-market read-later app (Mozilla-owned since 2017), shut down July 8 2025; exports allowed until Oct 8 2025 (extended ~Nov 6), then permanent deletion. Premium subscribers refunded pro-rata.

- **Architecture:** Cloud, proprietary, closed. Mozilla — the privacy nonprofit — still deleted everyone's decade of saves on a schedule.
- **Traction:** Dead. Its shutdown was the single biggest user-migration event in this category in 2025: Readwise, Karakeep, Wallabag, Instapaper all absorbed refugees.
- **Steal:** The migration playbook it triggered: every survivor shipped Pocket-CSV importers instantly. Also proof that even benevolent stewardship doesn't protect cloud data — institution risk ≠ VC risk, same outcome.
- **Avoid:** Nothing to copy; it existed to demonstrate that 'trusted org' is not an architecture.
- **Sources:** https://techcrunch.com/2025/05/22/mozilla-is-shutting-down-read-it-later-app-pocket · https://cyberinsider.com/mozilla-to-shut-down-pocket-service-in-july-to-allow-exports-until-october/

### ActivityWatch (added) — threat: low

Open-source, fully local automated time-tracker (app/window/browser/AFK watchers → local time-series 'buckets' with a query language and dashboard). The longest-running honest local-first capture project.

- **Architecture:** Local-only REST server (Python + Rust implementations), extensible watchers, data never leaves the machine; decentralized sync perpetually 'work in progress'. No LLM, no canon, no MCP (community wrappers exist).
- **Traction:** 18.8k stars, 1.0k forks; maintained but slow-moving — sync has been WIP for years, small maintainer team.
- **Steal:** The watcher/bucket model: many small per-source capture daemons writing typed events into a local queue is exactly Kokoro's ingestion shape, proven over a decade. Also an obvious Kokoro connector (import AW buckets).
- **Avoid:** The plateau: pure capture with no distillation and no story stalled at 'niche quantified-self dashboard' despite huge stars — evidence that capture alone is not a product, the canon layer is.
- **Sources:** https://github.com/ActivityWatch/activitywatch

### Nango (added) — threat: low

Open-source (Elastic License v2) integration runtime — the anti-Composio: 900+ APIs, self-hostable from day one, MCP support, used in production by Replit, Ramp, Mercor. v0.70.1 Apr 2026, multiple releases per month.

- **Architecture:** Self-hostable auth + sync infrastructure; you own credentials and deployment. ELv2 not OSI, but source-open and self-run. Dev-infra, no personal-canon ambitions.
- **Traction:** 10.7k stars, 1.1k forks, sustained release cadence through mid-2026, real production logos.
- **Steal:** The credible answer to 'how does a zero-phone-home system do OAuth to Gmail/Calendar': Nango-style self-hosted auth runtime patterns (or Nango itself as an optional connector backend) instead of reinventing token refresh for 20 APIs.
- **Avoid:** Its buyer is SaaS engineering teams — the DX assumes developers. Kokoro's stranger is not that; wrap any such infra behind opinionated defaults.
- **Sources:** https://github.com/nangohq/nango · https://nango.dev/blog/composio-vs-nango/

**Category lessons:**
- Cloud capture dies and takes the data: Omnivore gave users 14 days, Pocket set a deletion deadline, Meta remotely disabled Rewind's capture. Three mass-deletion events in 13 months created a burned, articulate refugee audience — Kokoro's 'canon is Markdown on your disk; our death costs you nothing' is not ideology, it is the category's proven acquisition channel (Readwise and Karakeep both grew off these funerals).
- Acqui-hire is the structural endgame for every funded capture product (Omnivore→ElevenLabs, Bee→Amazon, Limitless→Meta, Beeper+Texts→Automattic, screenpipe now in YC). Even 'open source' (Omnivore) and 'local storage' (Rewind) didn't protect users — only plaintext-on-owner-disk plus a runnable OSS codebase does. State this exit-proofness explicitly in Kokoro's README.
- Nobody has the canon layer. Every competitor stops at one of: raw searchable archive (screenpipe, Rewind, ActivityWatch), auto-tagged storage (Karakeep, Readwise), or autonomous AI-generated 'facts about you' with no approval step (Bee, Fabric — and Bee's hallucinated to-dos are a live trust complaint). Capture→staged proposal→owner review→promoted canon is genuinely unoccupied; it is Kokoro's whole differentiation, defend it as such. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
- Connectors are a treadmill priced in headcount: Beeper keeps ~12 messaging bridges alive with a 30-person Automattic-funded team; Composio maintains 1,089 toolkits on VC money. A solo OSS project must ship adapters over existing rails (mautrix/Beeper bridges, IMAP, CalDAV/ICS, export-file importers, ActivityWatch buckets, Readwise API) and promise few first-party connectors, loudly.
- Import-the-dead is free growth: every 2025-26 winner shipped Omnivore/Pocket importers within weeks of each shutdown and Karakeep rode it to 28.7k stars. Kokoro should launch with importers for the graveyard (Pocket CSV, Omnivore export, Rewind/Limitless exports, Readwise Markdown) as a stated feature.
- Stranger-installability decided the OSS winners: Karakeep (docker-compose, 28.7k stars, 3 years old) lapped Wallabag (PHP+Composer+MariaDB, 10+ years old) on install friction alone. One command to first captured item is the bar.
- Trust posture leaks kill the premium position: screenpipe ships default PostHog/Sentry telemetry in a 'local-first' app; Omi brands MIT-open-source while defaulting audio through Deepgram+Firebase. Communities audit and remember. Zero-phone-home must be literally true, verifiable in code, including analytics — it is the one claim competitors keep fumbling.
- MCP read access is table stakes by 2026 (screenpipe, Composio, Nango, Karakeep agent skills all shipped it), but sensitivity gating on that surface barely exists — only screenpipe's $150/seat enterprise tier has per-agent data permissions, enforced via YAML below the prompt layer. Their enforcement-not-prompting design is worth copying; shipping it free and personal is a wedge.
- Monetization pressure bends every OSS project's license (screenpipe → source-available + $25/mo, Nango → ELv2, Karakeep → paid cloud): pick Kokoro's license and revenue posture (hosted convenience? support? nothing?) on day one — retrofits burned each community that experienced them. The durable counter-example is Readwise: bootstrapped, ~$14M ARR, 28 people — niche subscription beats VC in this category, and VC money reliably converts into a kill switch (Rewind) or a pricing wall (Composio's $599/mo self-managed-credentials tier).
- Demand for total capture is validated but totality doesn't sell: Rewind's own team found narrowing to conversations 'more useful and easier to explain', Bee won on $50 zero-config ergonomics, and pure-capture ActivityWatch plateaued despite 18.8k stars. Lead Kokoro's pitch with one sharp loop (e.g. messages+calendar → reviewed personal canon → agents that actually know you) rather than the everything-firehose. (Kizuki-side review/promotion-gate claim superseded 2026-09-02, see `docs/decision-log.md` C8 and D10.)
