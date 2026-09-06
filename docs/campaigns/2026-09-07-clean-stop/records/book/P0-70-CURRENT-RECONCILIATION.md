# Issue 70 current reconciliation

Evidence date: 5 September 2026.

## Decision

**REMAINS OPEN.** The vault-root, descendant, ancestor and discovered-marker
paths are fixed on exact clean candidate
`2f5e37998c5b14eb2e94566a8913a396ed17ce5f`, tree
`bbab8207eaa92f8a2f1f72a0fed4c7e5f0fd8fd4`. The second requirement in
[issue 70](https://github.com/Illuminfti/kizuki/issues/70) is still
reproducible: exact loop-written bytes copied into an independent unmarked
Markdown source become a new ledger event and reach model extraction.

The existing boundary repair is useful and its documentation is honest. It
does not close the full P0. No owner review or promotion queue belongs in the
remedy.

## Binding contract

RFC 0002 specifies two related reader-side controls:

1. `events.origin` is a spine-owned `external | self` stamp. Self events stay
   in history but are excluded from extraction (`rfcs/0002-autonomous-canon.md`
   lines 676-680).
2. The loop writer records the hash of every byte it writes and the watcher
   ignores matching content. The named regression is `self-write is not
   re-ingested` (lines 1789 and 2235-2238).

The writer already provides the content evidence needed for exact copies.
Every canon receipt carries `writer`, `before_hash` and `after_hash`, and
`after_hash` is the SHA-256 of bytes read back from disk after the write.
Machine-created pages are also segregated under `auto/`, but that path does not
travel when a file is renamed or copied.

## Current implementation gap

The current implementation does not carry the RFC origin stamp:

- `CaptureEvent` has no `origin`, and `CaptureEventInput` omits only
  spine-generated `event_id` and `content_hash`.
- The `events` table has no `origin` column. `accept()` stores the validated
  event without consulting canon receipts.
- Event `content_hash` cannot serve as the machine-byte stamp. It hashes the
  canonical event envelope, including connector, source-record identity,
  occurred time, subjects and metadata. Renaming or copying the same bytes
  therefore produces a different digest from the canon receipt `after_hash`.
- Extraction checks only `event.text.includes("KIZUKI CONTEXT v1")`. That
  protects context packets but not ordinary loop-written canon pages.
- `EventFacts.origin?` exists as an unused optional type surface; it is neither
  populated nor used to deny extraction.
- The RFC-named `packages/core/test/loop/self-ingest.test.ts` is absent. The
  existing tri-state regression covers only the context-packet marker.

The Markdown mapper correctly rejects marked vault roots and scans that
discover `.kizuki`. For an independent source it emits the file text and an
exact raw-byte SHA-256 in metadata, with no machine-origin decision. The
repository states this limit directly in `docs/markdown-sources.md`: copied
generated text in an unmarked source and machine-origin matching remain
unqualified.

## Public-seam reproduction

The synthetic probe uses only exported Core and connector APIs:

1. Initialize a producer vault and accept one synthetic seed event.
2. Insert a synthetic model claim and call `applyCanonWrite` with
   `writer: "loop"`, producing `auto/people/synthetic.md` and a real receipt.
3. Copy those exact bytes as `renamed-copy.md` under an independent unmarked
   source.
4. Capture through `createMarkdownFolderConnector().backfill(null)` and store
   through `accept()` in the same vault ledger.
5. Invoke exported `runWritePass` with a bounded recording producer.

Command:

```bash
TEMP/bunx-1000-bun@1.3.10/node_modules/@oven/bun-linux-x64-baseline/bin/bun \
  TEMP/p0-70-current-probe.ts
```

Probe source SHA-256:
`17d4bebc58e0522a6e7255674bee4736af06d419fbc6286f05a00467414be5a6`.

Result:

```json
{
  "passed": true,
  "exact_machine_bytes": true,
  "copied_event_status": "stored",
  "event_origin_column": false,
  "event_content_hash_equals_machine_after_hash": false,
  "producer_called_with_copy": true,
  "packet_marker_present": false,
  "write_pass_stopped": null,
  "write_pass_errors": [],
  "writer": "loop",
  "page_path": "auto/people/synthetic.md"
}
```

The seed contained the context marker and was excluded, so the producer's one
input was the copied loop page. The model returned an empty result; the probe
does not create a second machine page or call a real model. The temporary
vaults and source were removed, and the product worktree remained clean.

## Bounded repair design

Enforce origin in Core acceptance and extraction, where all connectors share
one trust decision. Do not trust connector metadata and do not repurpose event
`content_hash`.

1. Add a spine-generated `origin: "external" | "self"` to `CaptureEvent` and
   durable storage. Keep ingress frozen by changing `CaptureEventInput` to omit
   `origin` as well as `event_id` and `content_hash`. Reject any connector that
   tries to supply it through the existing exact-key validation.
2. After source authorization, recompute a separate SHA-256 over the exact
   UTF-8 event text. Classify the event as `self` when either the context marker
   is present or that digest matches bytes recorded by a loop receipt. Never
   trust `metadata.sha256` for this decision.
3. Match indexed `canon_receipts` where `writer = 'loop'`. Include non-null
   `before_hash` as well as `after_hash`: the loop writes archived prior bytes
   too, and the RFC rule covers every byte it writes. Exclude the empty-byte
   absence sentinel so an ordinary empty capture is not classified as machine
   output.
4. Make extraction eligibility depend on durable `origin !== "self"`.
   Retain marker recognition when assigning origin as defense in depth, while
   removing the literal substring check as the sole extraction control.
5. Backfill existing events deterministically from the marker and available
   loop receipt hashes. Keep origin evidence through replay, backup, restore,
   purge and storage-port round trips.

False-positive self classification only suppresses an untrusted source event;
it never raises authority. A connector cannot forge itself into a stronger
origin. This keeps the machine-origin rule fail closed without adding an owner
decision path.

## Required race rule

`writePage` makes file bytes visible before the receipt row is inserted. A
concurrent capture can therefore observe a loop output before the receipt-hash
lookup can see it. The repair must close that interval rather than merely add a
best-effort query in `accept()`.

A bounded solution may recheck the spine-computed text stamp against the
indexed loop-hash set at extraction time, under the existing writer/source
authorization fence. Another valid design may publish the machine hash before
the file becomes observable and reconcile failed writes. Whichever mechanism
is chosen, a capture interleaved after file publication but before receipt-row
commit must remain ledgered as `self` or otherwise be ineligible for
extraction. Failure to read or validate the machine-hash registry must not
silently classify a candidate as external.

## Acceptance cases

- Exact loop-created page bytes copied and renamed in an independent source:
  ledgered `self`, producer not called, extraction cursor advances.
- Exact bytes from a loop edit of an existing human page: same result.
- Exact archived prior bytes recorded by a loop receipt: same result.
- Context packet with no matching receipt: ledgered `self`, producer not
  called.
- Forged connector `origin` or forged `metadata.sha256`: rejected or ignored;
  classification comes from spine-computed bytes.
- One-byte-changed ordinary source: `external` and extractable, proving the
  rule is exact-content based rather than a broad frontmatter heuristic.
- File-publication/receipt-commit interleaving: copied bytes never reach the
  producer.
- Migration, replay, export/restore and purge retain the origin decision.
- Existing vault marker, alias, nested-vault, cursor and tombstone protections
  remain unchanged.

## Closure boundary

The current marker checks close direct vault and ancestor scanning. Issue 70
can close only after the exact-copy public seam above is red-to-green and the
receipt-publication race is covered. Hash matching proves exact machine bytes;
it does not claim semantic detection of rewritten or excerpted machine prose.
