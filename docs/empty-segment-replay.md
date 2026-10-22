# Guarded replay of a settled empty segment

This repair operation reopens only the first, successfully empty prefix of an
unfinished source record after a reviewed producer repair. It is not a general
re-extraction command, a model retry, or an automatic semantic-failure retry.

```bash
kizuki serve replay-empty --plan /absolute/private/plan.json --plan-sha256 SHA256 --json
```

The command binds the actually configured built-in typed producer but makes no
model, connector, retrieval or canon request. Core's public operation is
`replayEmptyExtractSegment({db, vault_path, producer}, plan)`; the public parser is
`parseEmptySegmentReplayPlan`. V2 supersessions use `parseEmptySegmentReplaySupersessionPlan`. The plan file must be an owner-owned regular file
with mode `0600`, one link, no symlink and at most 16 KiB. The CLI hashes and parses
the same descriptor-read bytes. Errors identify a fixed refusal code, never plan
contents, paths or source text.

## Plan and historical trust

The closed `kizuki.extract-empty-replay/v1` plan contains exactly:

- `schema`, `operation_id`, `vault_id`, `event_id`, `connector_id`, `source_key`.
- `content_hash`, `text_hash`, `source_revision`, `source_policy_digest`,
  `source_epoch`, `model_binding_digest`, `expected_cursor`.
- `segment`: exact `status`, `chars`, `done_utf16`, `pending_end_utf16`, `updated_at`.
- `old_run_id`, `old_run_receipt_sha256`, `old_producer_fingerprint`,
  `new_producer_fingerprint`, `new_qualification_sha256`, `new_review_sha256`.
- `historical_evidence`: `kind: owner_attested_legacy_empty`, `old_source_commit`,
  `old_prompt_sha256`, `old_gate_sha256`, `old_input_plan_sha256`,
  `independent_review_sha256`, `legacy_metadata_sha256`,
  `allowed_errors_sha256`, `capture_denial_proof_sha256`.
- `reason: producer_false_negative_repair`.

Only `status: segmenting`, `pending_end_utf16: null`, and
`0 < done_utf16 < chars` qualify. The old run must be a full sync with exactly
one answered call, one segment, zero extracted and rejected claims, no skip and
known usage. Its exact retained `run_receipts.report` bytes must match the plan.
The new and old producer fingerprints must differ. The retained receipt row must
match its report. A successful run has no errors and null exception hashes. A
degraded run must have exactly one error whose canonical JSON array digest matches
`allowed_errors_sha256`, plus a non-null `capture_denial_proof_sha256`. The sealed
legacy metadata and independent review must attest that exact error is a capture
denial for a previously purged synthetic canary. Core verifies the error digest;
it cannot independently establish that external classification. Unrelated prior
canon writes may coexist with the empty extraction; reverts, extraction skips,
deduplication, supersession or unknown token usage do not qualify.

Older versions did not persist an empty segment's producer fingerprint or raw
response. The old identity is therefore a reviewed reconstruction from the old
source and composed prompt, explicitly attested by the local owner. Qualification,
gate, input-plan and independent-review hashes bind externally reviewed artifacts;
Core cannot establish their truth, independence or hidden historical model text.
The owner must retain and independently verify those immutable artifacts before
using the plan. Hashes alone do not prove semantic quality. Core recomputes every
current ledger, source, consent and claim-absence guard; there is no trusted
`empty: true` switch or existing-claim rewrite.

`modelProducerFingerprint` returns an identity only for an intact built-in factory
port. Its frozen callable/descriptor binding covers the composed ordinary and
grounding prompts, active registry and explicit implementation revision. Source,
package, review and evaluator pins remain separate release evidence.

## Superseding an empty replay

The closed `kizuki.extract-empty-replay/v2` plan adds `parent` with exactly
`operation_id`, `plan_sha256`, `current_done_utf16`, `current_updated_at`,
`settlements_sha256` and `run_receipts_sha256`. The child preserves the parent's
whole prefix cap, source identity, grant revision, policy epoch, model destination
binding and global cursor. Its new producer fingerprint differs, while its old
fingerprint names the parent producer. The separate current-progress snapshot
must be strictly inside that unchanged cap.

Core recomputes every parent settlement decision ID using the canonical
`[run_id, outcome, decision]` recorded by ordinary extraction. All rows for that
parent operation must form one contiguous empty prefix from zero to the pinned
current progress, bounded to 1024 settlements. The plan hashes the ordered rows
and the sorted run IDs with hashes of their exact retained report bytes. Each
report must account for exactly those answered segment decisions, known usage,
zero claims, rejects, capture, canon writes, reverts, skips and errors. The report
row metadata must match. No unrelated decisions may share the report authority.

Acceptance preserves the immutable parent plan, settlements and reports and
atomically replaces its active link with the child at zero. One child per parent
and at most 16 operations per event are supported; missing ancestors, forks and
cycles refuse. An identical active child plan is idempotent without another reset;
a completed or superseded child cannot reactivate through that response. The
existing ordinary extraction path then covers the child's entire unchanged cap.
The command itself never invokes a model or retries extraction.

## Atomicity and ordinary extraction

The existing vault writer lock and ledger lease surround one immediate
transaction. A busy writer, pending batch/usage/canon recovery/purge, changed
event/source/consent/model/producer/cursor/checkpoint, or ambiguous/overlapping
model claim of any status refuses. Malformed or unlocated model provenance cannot
prove disjointness. Only one replay may be active.

Acceptance inserts an immutable metadata receipt and compares-and-swaps the
segment-local offset to zero with its replay link and timestamp. It preserves
the global cursor, queued inputs, events, claims and historical receipts. Repeating
the identical operation returns `already_applied` without resetting progress;
changing its plan refuses. V1 refuses a second operation for the same event, even
with another producer, old run or prefix boundary. This idempotent response does not authorize a new model
request after consent changes.

Ordinary sync revalidates the live producer and source before each replay request
and settlement. It uses the existing planner, durable decision journal, claim
filing and receipted canon writer. Smaller legal segments may cover the prefix;
even a larger budget cannot cross the old end. An unfit or rejected replay stops
without skipping it. Rejection history/backoff is retained. Unrelated input at
the head of ordinary selection refuses rather than being silently consumed.
Other world-model jobs wait during a replay pass.

At the old end, the same transaction clears the active link, and extraction reports
`extract:replay_complete` and stops even if the result is empty. That status means
the approved interval settled, **not** that the semantic repair succeeded. The
operator must keep subsequent sync/service activation paused until the independently
specified consumer query succeeds. A later ordinary pass can consume the queued
remainder; this operation does not create a second persistent pause/resume system.

## Storage, backup and verification

Ledger schema 48 adds immutable replay receipts, source-linked segment settlement
metadata and a nullable active link on oversized progress. Future successful empty
segments from the built-in producer record bounds, content hash, producer/model
identity and settling run atomically with progress. Nonempty replay segments record
the same linkage in the existing atomic claim-filing completion. Interrupted
nonempty decisions retain the existing journal and file without another request.
Settlement run IDs identify the completing pass, which may differ from the request
pass after interruption. No source text or raw response is stored in these tables.

Existing export/restore carries both metadata streams and the active cap; schema48
backups missing them refuse. Restore checks digests, source identities, bounds and
links. V2 also exports `serve/extract-replay-runs.jsonl`, containing the
exact reports of replay-linked settlements, including the active or completed
leaf, so later recovery can still verify its evidence. Restore validates the entire
lineage after all streams have landed in its staging transaction, regardless of
operation-ID order or whether the child is still active. Missing or corrupt
lineage refuses without publishing a partial vault. Earlier V1 archives need no
run-report stream. Receipt pruning preserves referenced reports at every lineage
depth, including completed operations; more than 4096 mandatory reports or 8 MiB
refuses pruning before changing its journal or ledger. Supported source/event
purge removes this source-linked metadata.

Synthetic verification covers public CLI/no transport, private-file custody,
atomic reset/rollback/idempotency, source and claim refusals, mutation-proof producer
identity, cap enforcement, revocation during requests, journal restart, schema47
upgrade, backup roundtrip and purge. Production replay still requires exact build,
plan and independent review bindings; synthetic tests do not establish a live
semantic result.
