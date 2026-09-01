# Kizuki architecture

Your life, queryable as a CLI and MCP. Not a harness; hosts no agents — every
agent harness brings its own loop and connects here as a first-class client.

## Invariants (CI-enforced where possible)

1. Canon is Markdown files on the owner's disk, forever. Deleting Kizuki
   leaves a readable vault.
2. Derived layers (search index, embeddings, graph) are rebuildable from the
   event ledger + canon with one command.
3. Nothing writes canon except an owner-invoked promote. No scheduled path
   may write canon — enforced by a test.
4. Append-only event ledger; purge is physical deletion plus a receipt.
5. Deterministic floor: capture, dedup, staging, search, review, and promote
   all work with zero LLM configured. LLM is strictly additive.
6. Zero phone-home: the only network calls are user-configured connectors and
   the user-configured model endpoint.
7. Captured content is attacker-controlled input. Serving surfaces separate
   canon prose from quoted capture and carry provenance.
8. Fail closed: missing sensitivity label → not served; missing credentials →
   connector refuses; unknown agent → no access.
9. Every scheduled rail emits a liveness receipt visible in `kizuki doctor`.
10. No fake surface: no registry entry, CLI verb, or README claim without a
    working implementation behind it.

## Layers

```
connectors → event ledger → staging proposals → owner review (TUI)
          → canon vault (Markdown) → derived (FTS/embeddings/graph)
          → serving (CLI · MCP · context packets) → proactive (serve daemon)
```

## Contracts

### kizuki.event/v1 — the frozen thin ingress

```ts
interface CaptureEvent {
  schema: "kizuki.event/v1";
  event_id: string; // ULID, spine-generated
  connector_id: string;
  source_record_id: string; // stable id in the source system
  kind: string; // message | email | calendar_event | ...
  occurred_at: string; // RFC3339, validated at accept
  observed_at: string; // RFC3339, validated at accept
  text: string;
  subjects: SubjectRef[]; // who this is about/from/to
  sensitivity_hint?: "public" | "personal" | "private";
  deleted: boolean; // tombstone from source
  attachments: AttachmentRef[];
  metadata: Record<string, unknown>; // persisted verbatim
  content_hash: string; // sha256 of canonical serialization —
  // computed by the spine, never caller-supplied
}
```

Queue semantics: `accept` → `stored | duplicate | error`; dedupe on
`(connector_id, source_record_id, content_hash)`; `event_id` collision with
different content is an error, not a duplicate. Read path: `readSince`,
`replay`. Tombstones cascade to open proposals automatically and to canon
only through the owner's review queue.

### kizuki.proposal/v1 — the only write path above the ledger

Entity / claim / edit / merge / deletion proposals with mandatory provenance
(`event_ids`), a `producer` stamp (`deterministic | llm | agent:<id>`), and
idempotency by content hash. Agents file proposals through the MCP `propose`
tool; there is no put_page and no in-place canon mutation, ever.

### kizuki.connector/v1

`manifest / health / connect / backfill / sync / revoke / purgeSource /
fixture`. In-tree curated registry; an entry exists only if the shared
conformance suite passes: fixture round-trip, fail-closed without
credentials, idempotent double-backfill, tombstone emission, purge plan,
checkpoint resume, manifest honesty. Credentials via `secret_ref` URIs
(`env:`, `file:`; keychain as optional package); core never stores plaintext.

**Sign-in, not setup.** `manifest.auth_modes` declares how a source is
connected: `sign_in` (phone code / app password in the terminal), `oauth`
(browser consent via PKCE and a loopback listener; core helper in
`auth/oauth.ts`), `secret_ref` (an existing token the owner points at),
`none` (files). `sign_in`/`oauth` receive `signIn(io, stateWriter)`; the
trusted host lends the terminal plus a scoped opaque-state writer, mints the
source key and state filename, and persists only a fixed safe envelope and
vault-relative state reference. Connector code neither chooses a path nor
returns durable connection config. Project-owned app credentials are compiled
in; nothing user-facing ever asks for a client id. Where a service has no
sanctioned user sign-in, the connector says so and offers export import
instead.

## Storage

Bun + TypeScript (strict). One SQLite DB (`bun:sqlite`, WAL) per vault under
`<vault>/.kizuki/`: events, purge receipts, proposals, promotion receipts,
checkpoints, schedules, run receipts, agents/grants/audit, FTS5, optional
embeddings, derived graph edges. The canon vault is a plain Markdown
directory (Obsidian-compatible) with machine-validated frontmatter: closed
type enum, required `sensitivity`, provenance `sources`, free `x-*`
extension namespace.

## Serving — agents as first-class citizens

- `kizuki agent add <name>`: identity + token + grants (sensitivity ceiling,
  scope filters, tool allowlist, rate limits). Enforcement happens in the
  query engine, below the prompt layer. Every call is audited.
- MCP (stdio per-harness, standing loopback under `kizuki serve`): read tools
  `search, get_page, query_entities, timeline, context_packet,
graph_neighbors, system_health`; one write tool `propose`.
- CLI: `query, timeline, entity, context --budget <n>` — bounded context
  packets for harness hooks without MCP overhead.

## Proactive (`kizuki serve`)

Program-first: the CLI works with no daemon. `serve` adds the scheduler
(connector syncs, daily brief, rollups, doctor sweeps), notifier plugins
(Telegram bot, email, webhook) that push digests and point back at
`kizuki review`, and the standing MCP endpoint. Every scheduled run writes a
receipt; stale receipts are reported as failures.

## Security

Threat model shipped in SECURITY.md: host-trust interim stance (plaintext
canon, versioned encryption seam reserved in the ledger), prompt injection
(invariant 7), agent overreach (grants + audit), connector supply chain
(in-tree curation). Purge is subject-keyed from day one. `kizuki export`
dumps vault + ledger — exit-proofness is a feature.
