# RFC 0001 — deep-model review: arbitration

Status: DRAFT (binds only when merged). Owner-gate items below are
superseded by BINDING RFC 0002. Arbitrates the external deep-model
review received 2026-09-01 (ten risks, ten proposed deltas, a schema
skeleton for an evidence-to-world-model layer) against
docs/architecture.md and RFC 0000. Each item is accepted, adapted, or
deferred; accepted items name where they now live in the tree.

## Accepted (already implemented or specified for the current waves)

- **Sensitivity lattice with an explicit bottom** (review delta D4). The
  serving order is `public < personal < private`, and anything unlabeled
  sits outside the lattice: it is never served to any principal, the owner
  included. Enforced in SQL by the search layer (`ceiling` option) and by
  `authorize()` in the agents layer, which reports `missing_sensitivity`
  before any ceiling comparison. Tests assert both.
- **Universal provenance keeps purge computable** (D6, D7 as a risk). Every
  derived row carries the ids it came from: search docs by `doc_id`, graph
  edges by `source` kind, proposals by `provenance`. A purge deletes ledger
  rows plus their receipts, withdraws pending proposals citing them, and
  files a `purge_review` packet for each canon page whose `sources`
  intersect the purged set; the page is held (`canon_holds`) and withheld
  from serving until the owner promotes the redaction. Canon is never
  edited by the purge itself (invariant 3).
- **Promotion receipts with file preconditions** (D9). Every receipt records
  `kind`, `before_hash` and `after_hash`; the write order is file → JSONL
  receipt → database row so a crash leaves a visible orphan `doctor` can
  report. Full multi-file transactional batches are deferred (below).
- **Taint separation on every serving surface** (D10, risk 1 in part). The
  serving envelope keeps `canon` (owner-reviewed prose) and `quoted`
  (captured text, `tainted: true`) in separate fields, each chunk stamped
  with its page or event id and its label. Temporal parameters on the
  serving surface are limited to `since`/`until`/`day` on the ledger for
  now; `as_of_valid`/`as_of_transaction` wait for the claim store.
- **Subject-keyed purge and identity as reversible candidates** (D3 in
  spirit). Subjects are first-class on events and proposals; identity
  links are proposals the owner confirms, never silent merges. The
  `subject_ref_key` normalization scheme itself is deferred with D1.

## Adapted

- **Review packets grouped beyond kind** (D8). The review screen groups by
  kind, then subject, then time, and shows diffs for edits, merges and
  purge reviews. Subject-level packets that bundle new facts, conflicts and
  deletions per person are the right end state; they arrive with the claim
  store, because a packet without atomic claims is only a longer list.
- **Deterministic floor for reduction** (risk 10, D7). The floor today is
  mechanical: entity candidates per subject and source-faithful captures.
  Claim atomization and conflict detection without an LLM are exactly the
  work RFC 0001 must specify with schemas and validators; until then the
  floor stays honest about being shallow rather than pretending depth.

## Deferred to RFC 0001 proper (Wave 5)

- The `wm_*` namespace: normalized event envelopes, activities, entity and
  identity candidates, claim atoms with bi-temporal validity, claim groups,
  review packets, promotion batches (D1, D2, D5, D8, D9-batches).
- The predicate registry and its seed list (§3.14 of the review).
- Query parameters `as_of_valid` / `as_of_transaction` / `include_evidence`.

Constraints for that RFC are unchanged from RFC 0000: consume
`kizuki.event/v1`, emit `kizuki.proposal/v1`-compatible packets, SQLite
only, deterministic floor preserved, provenance total, no new canon write
path. The skeleton's schemas are a good starting point; the RFC must add
worked examples that run against the fixtures in this repo and CI
invariants (§3.16 of the review) expressed as tests.

## Rejected

- **Redefining the ingress contract** to carry actor/direction/thread
  fields natively (risk 1). Ingress stays frozen (RFC 0000 §1). Connectors
  already carry these facts in `metadata` and `subjects`; normalization is
  the deep layer's job, downstream of the ledger, where it can be rebuilt.
