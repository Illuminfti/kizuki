# Kizuki architecture

Your life, queryable as a CLI and MCP. Not a harness; hosts no agents — every
agent harness brings its own loop and connects here as a first-class client.

This page is the invariant and contract map. [README.md](../README.md) is the
product front door. [cli.md](cli.md) is the verb list that exists on this
revision. Binding intent is [CURRENT.md](CURRENT.md) and
[RFC 0002](../rfcs/0002-autonomous-canon.md). Where a paragraph below describes
accepted design that is not a public command yet, it says so.

## Invariants (CI-enforced where possible)

1. Canon is Markdown files on the owner's disk, forever. Deleting Kizuki
   leaves a readable vault.
2. Derived layers (search index, embeddings, graph) are rebuildable from the
   event ledger + canon with one command.
3. Canon is written autonomously by the loop. Every canon write is a
   receipted, reversible transaction carrying provenance (`event_ids` that
   resolve in the ledger), confidence, a sensitivity label, a writer stamp,
   the model reference when a model produced it, and before/after content
   hashes. `kizuki undo <receipt>` reverses any write. There is no owner
   review queue and no owner approval step — enforced by tests.
4. Append-only event ledger; purge is physical deletion plus a receipt.
5. Deterministic floor: capture, dedup, the ledger, search, timeline,
   context packets, audit and undo all work with zero models configured. A
   configured model is required for canon writing only. With no model,
   `kizuki doctor` reports `canon writing: off (no model configured)` and
   the loop still syncs, ledgers, indexes and serves.
6. Zero phone-home: the only network calls are user-configured connectors and
   the user-configured model endpoint.
7. Captured content is attacker-controlled input. Serving surfaces separate
   canon prose from quoted capture and carry provenance.
8. Fail closed: missing sensitivity label → not served; missing credentials →
   connector refuses; unknown agent → no access.
9. Every scheduled rail emits a liveness receipt visible in `kizuki
   doctor`. A rail is reported down when its receipt is stale, when its
   service unit is absent, disabled or masked, or when its last runs
   produced nothing for a rail that should produce. Absence is never read
   as health.
10. No fake surface: no registry entry, CLI verb, or README claim without a
    working implementation behind it.
11. Owner correction is the highest evidence tier. It supersedes the
    contradicted claim immediately, rewrites affected canon in the same
    pass, needs no confirmation, and answers with a diff.
12. Captured text is data, never instruction. Extraction runs with no
    tools; instructions found inside captured text are never executed;
    canon pages carry a `taint` field; serving keeps canon prose and quoted
    capture in separate fields.
13. Every replaceable component sits behind a versioned port contract in
    `packages/core/src/contracts`, with a registry, a shared conformance
    suite, and config-driven selection. No component reads another
    component's storage.
14. Purge is computable and verifiable across every store, including the
    retrieval engine. `kizuki purge --verify <receipt>` prints an absence
    proof per store, and an unresolved purge operation is a `doctor`
    failure.

## Layers

```
connectors → event ledger → extraction (deterministic → model)
          → claims (provenance · confidence · sensitivity · authority)
          → canon vault (Markdown) via the receipted writer
          → derived (retrieval port: lexical/vector/graph)
          → serving (CLI · MCP · context packets)
          → audit & undo (TUI) · proactive (kizuki serve)
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
`replay`. Tombstones cascade to open claims automatically and to canon
through the receipted writer.

Ingress preserves opaque native identifiers without hashing or truncation.
`connector_id`, `kind`, and attachment media types are capped at 256 UTF-8
bytes; `source_record_id` at 1,048,584 bytes (a 1 MiB native id plus the
largest importer duplicate suffix, `#1000000`); `subject_id` at 1,024 bytes;
and `attachment_id` at 2,048 bytes. The full accepted event remains capped at
2 MiB.

### kizuki.claim/v1 — the working model and the write journal

Entity / claim / edit / merge / deletion records with mandatory provenance
(`event_ids`), a `producer` stamp (`deterministic | llm | agent:<id>`), and
idempotency by content hash. Agents file claims through the MCP `propose`
tool and correct the model through the MCP `correct` tool. There is no
put_page and no in-place canon mutation by any client, ever: every canon
byte is written by the receipted writer from a claim, and every write is
undoable by receipt.

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

Connector minor 2 adds an optional third `signIn` argument supplied by the
trusted host: `{ mode: "new" }` for enrollment, or `{ mode: "replace",
previous_state }` for reauthentication. Replacement receives a copy of the
previous opaque bytes, so a connector can check identity and revocation before
browser or network work without changing the host's verification snapshot.
Existing two-argument connectors keep their behavior. Implementations that
require this context refuse context-less calls; hosts never infer the mode from
the presence of a secret reference.

## Storage

Bun + TypeScript (strict). Authoritative state is one SQLite database (`bun:sqlite`, WAL) per vault
under `<vault>/.kizuki/`: events, purge receipts and purge operations,
claims, canon receipts, checkpoints, schedules, run receipts, leases,
agents/grants/audit, and the minimal FTS5 index. Derived retrieval is a
port; its implementation owns its own store under
`<vault>/.kizuki/retrieval/` and is rebuildable from ledger + canon with one
command. Canon is a plain Markdown directory (Obsidian-compatible) with
machine-validated frontmatter: closed type enum, required `sensitivity`,
required `taint`, provenance `sources`, free `x-*` extension namespace.

## Serving — agents as first-class citizens

Implemented on this revision:

- **CLI query.** `kizuki query` is the public read verb. Timeline, entity
  listing, and context packets are core serving functions exposed over MCP,
  not CLI verbs.
- **MCP stdio.** `bun packages/mcp/src/bin.ts --vault PATH (--owner | --token-env VAR)`.
  Read tools: `search`, `get_page`, `query_entities`, `timeline`,
  `context_packet`, `graph_neighbors`, `system_health`. Write tools:
  `propose` and `correct`. There is no `put_page`.
- **Loopback HTTP.** `kizuki serve` binds loopback unless `--no-http`.
- **Agent identity in core.** Grants, sensitivity ceilings, tool allowlists,
  rate limits, and audit live in `@kizuki/core`. There is no
  `kizuki agent add` CLI verb on this revision.

Enforcement happens in the query engine, below the prompt layer.
The public core search and timeline APIs require an explicit validated
sensitivity ceiling; null or unlabeled records are never returned. See the
[query ceiling contract and compatibility note](query-ceilings.md).

## Proactive (`kizuki serve`)

`kizuki init` installs `kizuki serve` as an always-on user service when a
supervisor is present. The daemon owns the loop, the retrieval writer lease,
and loopback HTTP. The CLI still runs with no daemon: it reads the ledger,
canon, and the lexical index directly, declares
`degraded: ["engine-unavailable"]` when the retrieval port is daemon-owned,
and refuses to write canon while another process holds the writer lease.

Rails on this revision: connector sync, retrieval sweep, purge sweep, embed
backfill, daily brief (file notifier into `dashboards/`), doctor sweep,
journal prune. Every scheduled run writes a receipt; stale receipts are
reported as failures. Telegram / email / webhook notifiers are accepted
design behind `kizuki.notifier/v1`; the shipped notifier is the file writer.

## Security

Threat model in [SECURITY.md](../SECURITY.md): host-trust interim stance
(plaintext canon, versioned encryption seam reserved in the ledger), prompt
injection (invariant 7), agent overreach (grants + audit), connector supply
chain (in-tree curation). Purge is subject-keyed from day one. `kizuki export`
dumps vault + ledger — exit-proofness is a feature.

The optional native FTS5 retrieval port owns a separate
`.kizuki/retrieval/kizuki.retrieval.fts5/store/retrieval.db`; this is distinct
from the main ledger's SQLite search floor. Every native FTS5 instance holds a
lifetime advisory lock, so a second instance reports busy. Source-revocation
maintenance closes its database and removes the entire disposable store under
that same lock. It refuses unexpected files and active SQLite snapshots. Broken
store recovery uses the native lock without reopening SQLite. These guarantees
cover native managed-store consumers; external copies and arbitrary raw database
handles are outside that ownership boundary. Ledger, claim, and canon erasure
remain separate core operations.

Owned native generation deletion uses a Linux-x64-qualified descriptor-relative
walker. Both roots and child directories remain bound to opened descriptors;
symlink/path replacement cannot redirect the recursive removal. A changed named
root refuses completion even when the originally opened generation was erased.
FTS/PG erasure on unqualified platforms remains unsupported/pending. Main-ledger
maintenance is separate and never passes through this generation walker.

If a root changed before native shutdown, the port seals and requires process
restart, retaining ownership without pathname cleanup. Queued work is fenced;
SQL already in progress under external root replacement is explicitly uncontained
and never counted as safe live-move or verified erasure. Successful maintenance
requires a stable owned generation, drained SQL and descriptor-bound absence.
