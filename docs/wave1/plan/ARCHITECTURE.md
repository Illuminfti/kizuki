# Kizuki — architecture

Your life, queryable as a CLI and MCP. Not a harness; hosts no agents. This
document is the build target for Wave 1–5 and the constraint set for GPT Pro's
deep-model RFCs. Fable's design calls are marked as such; everything traceable
to a settled decision cites the decision log in
[MASTERPLAN.md](MASTERPLAN.md).

## 0. Invariants (violating any of these is a bug, most are CI-enforced)

1. Canon is Markdown files on the owner's disk, forever. Deleting Kizuki
   leaves a readable vault. (Logseq/Anytype lesson.)
2. Everything derived (indexes, embeddings, graph) is rebuildable from queue +
   canon with one command.
3. Nothing writes canon except an owner-invoked promote. No scheduled path may
   write canon — enforced by a test, not a docstring. (Estate auto-promotion
   lesson.)
4. Append-only event ledger; purge is physical deletion plus a receipt, never
   an in-place rewrite. (mem0 ADD-only retreat; honest-deletion doctrine.)
5. Deterministic floor: capture, dedup, staging, search, review, promote all
   work with zero LLM configured. LLM is strictly additive enrichment.
6. Zero phone-home: no network call except user-configured connectors and the
   user-configured model endpoint. CI asserts no telemetry SDK in the
   dependency tree and runs a network-denylist test.
7. Captured content is attacker-controlled input. Serving surfaces separate
   canon prose from quoted capture and carry provenance.
8. Fail closed everywhere: missing sensitivity label → not served; missing
   credentials → connector refuses; unknown agent → no access.
9. Every scheduled rail must emit a liveness receipt visible in `kizuki
doctor`. A rail without a fresh receipt is reported down, even if a port is
   open. (Masked-timer lesson.)
10. No fake surface: no registry entry, CLI verb, or README claim without a
    working implementation behind it.

## 1. Topology

- **Language/runtime:** TypeScript (strict) on Bun ≥ 1.2. One repo,
  Bun workspace.
- **Distribution:** compiled single binary (`bun build --compile`) via GitHub
  releases + install script + Homebrew tap; `npm i -g kizuki` / `bunx kizuki`
  as the registry path. (PyPI `kizuki` claimed defensively; no Python product.)
- **Processes:** the `kizuki` CLI is the product. `kizuki serve` runs the
  daemon: scheduler, sync loops, notifier dispatch, standing MCP endpoint.
  Without the daemon everything still works on demand (sync/review/query run
  in-process). Daemon is loopback-only.
- **Layout on disk:**
  - `<vault>/` — the canon vault, owner-chosen path, Obsidian-openable.
  - `<vault>/.kizuki/` — operational state, gitignored by generated
    `.gitignore`: `kizuki.db` (SQLite, WAL), `receipts/` (JSONL append logs),
    `secrets` handle files if `file:` resolver used.
  - `~/.config/kizuki/config.toml` — global config; multiple vaults allowed,
    one default.
- **SQLite via `bun:sqlite`.** Single DB, these table groups: `events`,
  `event_purges`, `proposals`, `promotions`, `checkpoints` (connector
  cursors), `schedules`, `run_receipts`, `agents`, `agent_grants`,
  `agent_audit`, `search_fts` (FTS5), `embeddings` (optional), `graph_edges`
  (derived). Derived tables carry a `rebuilt_at` stamp and a `kizuki rebuild`
  path.

## 2. Data plane — the event ledger

### 2.1 Contract `kizuki.event/v1` (frozen thin ingress; decision 4)

```ts
interface CaptureEvent {
  schema: "kizuki.event/v1";
  event_id: string; // ULID, spine-generated
  connector_id: string; // "kizuki.telegram" etc.
  source_record_id: string; // stable id in the source system
  kind: string; // message | email | calendar_event | health_sample
  // | post | file | screen_activity | contact | ...
  occurred_at: string; // RFC3339, validated at accept
  observed_at: string; // RFC3339, validated at accept
  text: string; // canonical text body ("" allowed)
  subjects: SubjectRef[]; // who this is about/from/to — day one (decision 4)
  sensitivity_hint?: "public" | "personal" | "private";
  deleted: boolean; // tombstone from source
  attachments: AttachmentRef[]; // content-addressed blobs under .kizuki/blobs
  metadata: Record<string, unknown>; // persisted verbatim (estate bug fixed)
  content_hash: string; // sha256 of canonical serialization —
  // COMPUTED BY THE SPINE, never caller-supplied
}
interface SubjectRef {
  role: "self" | "from" | "to" | "about";
  handle: string;
  namespace: string; /* "telegram" | "email" | ... */
}
```

Repairs baked in from the lifeos-oss autopsy: spine-computed `content_hash`
(caller cannot collapse edits), metadata persisted, timestamps validated,
`event_id` collision distinct from benign duplicate, and a real read path.

### 2.2 Queue semantics

- `accept(event)` → `stored | duplicate | error`. Dedupe key
  `(connector_id, source_record_id, content_hash)`; unique `event_id`
  collision with different content is an **error**, not a duplicate.
- Read API: `readSince(cursor)`, `replay(filter)` — staging is driven from the
  ledger, never inline from connector output.
- Tombstones (`deleted: true`) propagate: staging proposals citing a dead
  event are withdrawn automatically; canon pages citing it enter the owner's
  review queue (invariant 3 — no silent canon edit).
- **Purge** (`kizuki purge --event|--subject|--connector`): physical DELETE of
  events + blobs + derived rows, cascade to open proposals, receipt appended
  to `event_purges` (event_id, reason, purged_at). Canon pages citing purged
  events go to the review queue as a purge packet. Subject-keyed purge works
  day one (decision 4).

## 3. Connectors

### 3.1 Protocol `kizuki.connector/v1`

```ts
interface Connector {
  manifest(): Manifest; // id, display_name, source_classes, capabilities,
  // auth_modes, custody:"local", outbound_actions:false
  health(): HealthReport; // healthy|degraded|auth_required|rate_limited|
  // paused|failed|disconnected — validated at construction
  connect(secretRef: string): ConnectResult; // validates for real; persists
  backfill(cursor?: Cursor): AsyncIterable<CaptureEventInput>;
  sync(cursor: Cursor): AsyncIterable<CaptureEventInput>;
  revoke(): void; // drop credentials
  purgeSource(): PurgePlan; // what a full-source purge will delete
  fixture(): CaptureEventInput[]; // mandatory synthetic fixtures
}
```

- In-tree curated registry (carried floor). No entry without a live
  implementation passing the conformance suite. Registry count is derived,
  never asserted as a constant in tests.
- Checkpoints (cursors) stored per connector in `checkpoints`; re-running
  backfill is idempotent by construction (ledger dedupe).
- Credentials via `secret_ref` URIs — `env:VAR`, `file:PATH` in core,
  `keychain:` as optional package. Core never persists plaintext secrets.
- **Sign-in, not setup (decision 16).** `manifest.auth_modes` declares how a
  source is connected: `sign_in` (phone code / app password in the
  terminal), `oauth` (browser consent via PKCE + loopback listener, core
  helper `auth/oauth.ts`), `secret_ref` (an existing token the owner points
  at), `none` (files). `sign_in`/`oauth` require `signIn(io, secretsDir)`;
  the CLI lends the terminal (`SignInIo`) and the connector writes only
  `file:` refs under `<vault>/.kizuki/secrets/`. Project-owned app
  credentials are compiled in; nothing user-facing asks for a client id.
  Telegram = MTProto user session (GramJS) — the account's own chats, not a
  bot; Google = installed-app OAuth (Gmail + Calendar read-only); X = OAuth
  2.0 PKCE; WHOOP = OAuth (confidential client → an opt-in broker package or
  owner-registered app, stated honestly); WhatsApp = export import + Business
  API (no sanctioned user sign-in exists); Screenpipe = local database.
- Adapters over existing rails, never first-party protocol maintenance
  (Beeper lesson): Telegram = Bot API + official export files; WhatsApp =
  Business API + export files; Gmail = API; IMAP = standard; Calendar = ICS +
  Google API; X = API/export; Screenpipe = adapter over its local DB; WHOOP =
  API; Composio = its SDK as a meta-connector; markdown-folder = fs watch.
- Graveyard importers ship as connectors too: ChatGPT export, Claude export,
  Pocket CSV, Omnivore export (funeral-audience lesson).

### 3.2 Conformance suite

One shared test battery every connector must pass: fixture round-trip to
ledger, fail-closed without credentials, idempotent double-backfill, deletion
tombstone emission, purge plan completeness, checkpoint resume, manifest
honesty (capabilities ⊆ implemented methods). This suite replaces trust.

## 4. Staging — proposals

### 4.1 Contract `kizuki.proposal/v1`

```ts
interface Proposal {
  schema: "kizuki.proposal/v1";
  proposal_id: string; // ULID
  kind: "entity" | "claim" | "edit" | "merge" | "deletion" | "purge_review";
  target?: string; // canon page id for edit/merge/deletion
  body: string; // markdown fragment to be reviewed
  frontmatter: Record<string, unknown>; // proposed page frontmatter
  provenance: string[]; // event_ids — REQUIRED, non-empty
  subjects: SubjectRef[];
  producer: "deterministic" | "llm" | `agent:${string}`;
  confidence?: number;
  status: "open" | "promoted" | "rejected" | "withdrawn" | "superseded";
  created_at: string;
}
```

- **Deterministic floor producers** (no LLM): sender/thread/date entity
  candidates, calendar events → typed pages, health samples → daily rollups,
  file imports → source-faithful pages, contact aggregation. Every event
  yields at least a mechanical staging trace.
- **LLM enrichment** (optional): entity extraction, atomic claims,
  summarization — via OpenAI-compatible endpoint (`base_url`+`model`+`key` in
  config, stdlib fetch, no provider SDKs). Cloud endpoints require the
  separate `allow_cloud_inference = true` flag; documented default is a local
  endpoint (Ollama-class).
- **Agent producers**: any connected harness may file proposals through the
  MCP `kizuki.propose` tool (§8.3). Producer is stamped `agent:<id>`;
  proposals are the ONLY write path agents have.
- Proposals never mutate canon; idempotent by `(kind, target,
content-hash-of-body)`; replays dedupe.
- GPT Pro's deep model (envelopes, activities, typed identity candidates,
  semantic reduction, review packets) lands as internal layers BETWEEN the
  ledger and proposals via RFC — it must consume `kizuki.event/v1` and emit
  `kizuki.proposal/v1`-compatible review packets. Both endpoint contracts are
  its written constraints.

## 5. Review and promotion

- `kizuki review` — the TUI (Fable-built, taste work): daily digest header,
  proposal queue grouped by kind/subject, j/k navigation, `p` promote,
  `r` reject, `e` edit-then-promote, `m` merge into existing page, diff view
  for edits, batch accept for low-risk deterministic kinds (explicit,
  two-key: flag + per-batch confirm). Median daily session target ≤ 5 min.
- Promote requires a sensitivity label on the resulting page (missing label
  blocks; fail-closed). Writes: canon page (new dated revision, never
  in-place clobber of an owner-edited file), receipt row in `promotions` +
  JSONL receipt (proposal_id, event provenance, label, before/after hashes,
  timestamp), FTS/derived update.
- `kizuki init` never overwrites owner-edited doctrine files (CANON/SCHEMA
  equivalents) — regression-tested.
- Rejection is recorded (id + reason) so re-proposals of the same content
  auto-suppress. (Estate auto-canon-queue lesson: rejected ≠ forgotten.)

## 6. Canon vault

- Markdown + YAML frontmatter, wikilinks, Obsidian-compatible directory —
  opens cleanly as a vault; Kizuki owns the review surface, not the editor
  (Reor lesson).
- Tree: `00-dashboards/ 01-inbox/ 02-staging/` are NOT in the vault — staging
  lives in SQLite; the vault holds only reviewed canon + raw exports:
  `entities/ facts/ events/ sources/ dashboards/ archive/`, generated
  `CANON.md`, `SCHEMA.md`, `.gitignore`. (Estate G2 lesson: nothing
  unreviewed sits in the backed-up plane.)
- Frontmatter schema, machine-validated at promote time and in `kizuki
doctor`: core keys `id, title, type (closed enum: person | org | project |
place | topic | event | fact | source | rollup), status, aliases, subjects,
sources (event provenance), sensitivity (REQUIRED: public|personal|private),
reviewed, next_review`; `x-*` namespace free for private extensions
  (estate importer uses it; lossy-mapping report at migration).
- Claims inside pages carry inline provenance markers (event_id anchors) so
  purge cascades and agent responses can cite.

## 7. Derived layers (all rebuildable, `kizuki rebuild`)

- **Search:** SQLite FTS5 over canon + ledger text — the deterministic floor
  for `kizuki query` and MCP search.
- **Embeddings (optional):** local model via node-native ONNX (fastembed
  class) or the configured endpoint; stored in `embeddings`; off by default;
  absence degrades to FTS, never breaks.
- **Graph:** `graph_edges` projected from wikilinks + subject refs; feeds
  `kizuki graph` queries and context packets. No graph database dependency.

## 8. Serving — agents as first-class citizens

The core product surface (the owner's framing: "your life queryable as a CLI and
MCP; agents must be first-class citizens"). Kizuki hosts no agents — every
harness (the personal harness, Claude Code, codex, Grok bots) brings its own loop and
connects here.

### 8.1 Agent identity and grants

- `kizuki agent add <name>` → agent record + local token. Grants per agent:
  sensitivity ceiling (`public` | `personal` | `private`), scope filters
  (types, subjects, time ranges), tool allowlist, rate limits. Default grant
  on creation: canon-only, ceiling `personal`, read + propose. The owner's
  own CLI session is implicitly the `owner` principal.
- Every agent call lands in `agent_audit` (agent, tool, query shape, pages
  served, timestamp). `kizuki agent audit <name>` renders it.
- Enforcement below the prompt layer: grants filter at the query engine, not
  in tool descriptions. (screenpipe ships this idea at $150/seat enterprise;
  Kizuki ships it free — whitespace claim.)

### 8.2 MCP server

- Real MCP (official TS SDK), stdio per-harness (`kizuki mcp`) and standing
  loopback HTTP under `kizuki serve` with per-agent tokens.
- Read tools: `search` (FTS/semantic), `get_page`, `query_entities`,
  `timeline`, `context_packet`, `graph_neighbors`, `system_health`.
- Write tool, exactly one: `propose` — files a `kizuki.proposal/v1` into
  staging. No put_page, no str_replace, ever. (Anthropic memory-tool hazard;
  Basic Memory pollution lesson.)
- Response envelope: canon prose and quoted capture are separate fields, each
  chunk provenance-stamped (page id / event id, sensitivity label) so
  consuming harnesses can apply data-not-instructions handling (invariant 7).
- Canon-only; ledger and staging are never served (carried floor). Missing
  label → withheld.

### 8.3 CLI query surface

`kizuki query "<question or filter>"` (FTS + filters, deterministic),
`kizuki timeline --day|--subject`, `kizuki entity <name>`,
`kizuki context --budget 450` — the bounded context packet (estate kernel
lesson: ~450-token briefs, retained-prefix deltas, fail-closed to empty),
consumable by any harness's hook (Claude Code session-context, the personal harness
context injection) without MCP overhead.

## 9. Proactive rails (`kizuki serve`)

- Scheduler in SQLite (`schedules`), cron-like; jobs: connector syncs,
  digest builds, rollups, doctor sweeps, embedding refresh. Every run writes
  a `run_receipts` row; `kizuki doctor` reports any rail whose receipt is
  stale (invariant 9). No OS cron/systemd requirement — the daemon owns it;
  a generated systemd/launchd unit is offered for the daemon itself.
- Daily brief: generated artifact (markdown, dashboard page) from the ledger
  - canon — same-day value on first backfill (Granola lesson). Deterministic
    skeleton; LLM narrative optional.
- Notifiers (plugins): Telegram bot, email, webhook/ntfy. Push the digest,
  point back at `kizuki review`. Notifiers are outbound-only channels owned
  by the OWNER, not agent surfaces.

## 10. Security and privacy

- Threat model in SECURITY.md from day one: host-trust interim stance
  (plaintext canon; encryption seam reserved via versioned key-id field on
  ledger/blobs), captured-content-as-attacker (prompt injection), agent
  overreach (grants + audit), connector supply chain (in-tree curation),
  disclosure channel.
- Zero phone-home covenant, CI-enforced (invariant 6). No update checks; the
  binary prints its version, the repo announces releases.
- Secrets: `secret_ref` only; gitleaks in CI; generated vault `.gitignore`
  excludes `.kizuki/` — with a test asserting the pattern actually matches
  (estate G2: the doctrine said gitignored, git tracked 731 files).
- Purge and subject rights: §2.2; export: `kizuki export` (full vault +
  ledger dump) — exit-proofness is a marketed feature.

## 11. Repo layout (Bun workspace)

```
kizuki/
  packages/
    core/        # contracts, ledger, staging, promotion, vault, derived
    connectors/  # one package per connector + conformance suite
    tui/         # kizuki review + dashboards (Fable-owned)
    mcp/         # MCP server + agent grants/audit
    daemon/      # serve: scheduler, sync loops, notifiers
    cli/         # verb wiring, compiled binary entry
  docs/          # architecture, SECURITY.md, RFCs (GPT Pro lands here)
  rfcs/          # numbered, status-stamped
```

CLI verbs (complete v1 set): `init connect sync backfill review promote
query timeline entity context graph doctor rebuild purge export agent mcp
serve import version`.

## 12. Testing and CI

- Lessons-as-tests ratchet (carried): scheduled-write-to-canon impossible;
  init-clobber refusal; hash-collapse regression; metadata round-trip;
  tombstone cascade; gitignore-matches-doctrine; receipt-staleness detection;
  fail-closed MCP label test; zero-network test; conformance suite per
  connector.
- CI: typecheck, test matrix (Linux/macOS), gitleaks, estate-identifier
  denylist grep, zero-phone-home dependency assertion, `bun build --compile`
  smoke on all targets, fresh-clone quickstart script.
- Releases: tag-triggered GO/NO-GO script only; never manual, never
  green-over-red.

## 13. Deferred to RFCs (GPT Pro constraint brief)

Identity resolution across sources (typed entity/identity candidates);
semantic reduction pipeline and claim extraction quality gates; review-packet
grouping beyond kind/subject; transactional promotion batches; bi-temporal
claim validity; insight derivation. Constraints: consume `kizuki.event/v1`,
emit `kizuki.proposal/v1`-compatible packets, SQLite-fit, deterministic-floor
preserved, no new canon write paths.
