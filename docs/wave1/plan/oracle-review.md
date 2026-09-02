# Oracle review — Kizuki architecture + RFC 0001 skeleton

> **Superseded in part on 2026-09-02.** `docs/CURRENT.md`, `docs/decision-log.md`
> and `rfcs/0002-autonomous-canon.md` are binding: autonomous canon with no
> owner review gate, auto-labeled sensitivity, a configured model required for
> the world model, retrieval behind a port, an MCP `correct` tool, an always-on
> daemon installed at init, and a modular monolith with pluggable ports. This
> document is a historical record; where it conflicts, the binding documents win.

Date: 2026-09-01
Source: GPT-5.5 Pro (ChatGPT browser mode, conversation 6a97153f-da40-83eb-a6da-6294032cf6eb)
Status: UNARBITRATED input. Fable arbitrates before anything binds. Nothing in
this document is accepted design; treat every claim as a proposal to be judged
against docs/architecture.md and rfcs/0000-constraints.md.

---

I’ll treat RFC 0000 as binding and keep the response implementation-facing: concrete risks, compliant architecture deltas, and an RFC 0001 skeleton that fits between ledger and proposal/review.

---

## 1. Adversarial review: 10 serious risks

| # | Design risk / flaw | Concrete failure caused |
|---:|---|---|
| 1 | **Ingress is frozen but semantically too thin.** `CaptureEvent` gives `kind`, `text`, `subjects`, `metadata`, but no normalized activity envelope: actor, direction, thread, reply chain, meeting span, source account, participant role. | A message like “yes, let’s do it Friday” becomes a claim without knowing who said it, what “it” refers to, whether it was inbound/outbound, or which thread it belonged to. Wrong facts get proposed. |
| 2 | **`SubjectRef` is first-class in principle but not specified enough to key identity, purge, or grants.** | The same person appears as Telegram user, email address, phone number, X handle, and Markdown page. The system either fails to join them or silently over-merges them. Purge-by-subject becomes incomplete. |
| 3 | **Sensitivity is only a hint at ingress and has no propagation algebra.** | One private source inside a packet can be reduced into a “personal” or “public” derived claim. MCP grants then leak derived facts because the derived row no longer carries the maximum source sensitivity. |
| 4 | **`kizuki.proposal/v1` is described as a bucket, not a concrete payload contract.** | Agents and reducers emit incompatible “claim”, “edit”, or “merge” proposals. Idempotency by content hash becomes meaningless because two semantically identical proposals serialize differently. |
| 5 | **No atomic claim store between ledger and Markdown canon.** | Canon promotion becomes page-edit generation instead of fact promotion. Contradictions, stale values, and “known at time X” questions cannot be handled without rereading prose. |
| 6 | **No bi-temporal validity model.** | “Alice works at X” and “Alice left X” overwrite each other or coexist as untyped notes. The system cannot answer “what did I believe on 2026-08-01?” versus “what was true during July?” |
| 7 | **Provenance is mandatory by policy but not universal by schema.** | Purge/revocation cannot be computed from event IDs alone once claims are grouped, summarized, embedded, indexed, graphed, or packetized. Deleted capture remains in derived surfaces. |
| 8 | **Review queue is not subject-level or conflict-aware.** | The owner receives hundreds of micro-proposals instead of coherent packets: “about this person/project, here are new facts, conflicts, deletions, and suggested promotions.” The gate becomes unusable and gets bypassed socially. |
| 9 | **Promotion is not transactionally specified across SQLite and Markdown files.** | A crash can leave Markdown changed without a receipt, or a receipt committed without the file write. Rebuild diverges from canon and `doctor` cannot prove which state is authoritative. |
| 10 | **Deterministic floor is stated but not designed for semantic reduction.** | With no LLM configured, capture and search may work, but entity extraction, claim atomization, conflict detection, and review packet generation collapse into empty output or brittle ad hoc behavior. |

---

## 2. Proposed architecture deltas respecting RFC 0000

| Delta | Change | RFC 0000 compatibility |
|---|---|---|
| D1 | Add a `wm_*` deep-model namespace in SQLite between `events` and `proposals`: normalized events, activities, subject refs, entity candidates, identity link candidates, claim atoms, claim groups, review packets, promotion journals. | Does not alter `kizuki.event/v1`; single SQLite DB. |
| D2 | Define deterministic, content-addressed IDs for all derived artifacts: `ne_*`, `sr_*`, `ec_*`, `ic_*`, `cl_*`, `cg_*`, `rp_*`, `pb_*`. | Rebuildable; idempotent; deterministic floor preserved. |
| D3 | Specify `SubjectRef` normalization into stable `subject_ref_key`s and reversible identity edges. Never collapse identities in-place. Owner decisions append identity-link decisions. | Subjects first-class; reversible; purge-keyable. |
| D4 | Add a sensitivity lattice: `public < personal < private < unlabeled`. Derived artifact sensitivity is the max of all source events, subject floors, attachments, and claim predicates. `unlabeled` is never served. | Fail-closed; no phone-home; local policy. |
| D5 | Add a claim predicate registry with typed values and validators. Claims are atomic, provenance-linked, append-only, and bi-temporal. | Proposal egress unchanged; SQLite-fit. |
| D6 | Add `wm_artifact_events` as universal provenance join. Every derived artifact has computable event ancestry. | Purge cascades computable from provenance alone. |
| D7 | Add semantic reduction stages with deterministic fallbacks and optional LLM enrichment. LLM outputs must validate against deterministic schemas before storage. | LLM additive only. |
| D8 | Add subject-level review packets that bundle proposal items by subject, conflict, tombstone, or purge. | Egress remains `kizuki.proposal/v1`-compatible. |
| D9 | Add transactional promotion batches with file-hash preconditions, staged writes, append-only journal phases, and recovery receipts. | Owner-invoked promote remains the only canon write path. |
| D10 | Extend serving/query surfaces with temporal parameters and taint separation: `as_of_valid`, `as_of_transaction`, `include_evidence`, `canon_only`. | MCP/CLI reads only; no new write path. |

---

# 3. RFC 0001 skeleton: evidence-to-world-model deep layer

```md
# RFC 0001 — Evidence-to-world-model deep layer

Status: Draft  
Depends on: RFC 0000  
Scope: ledger → normalized evidence → subject/entity candidates → atomic claims → reductions → review packets → proposal-compatible promotion batches

## Non-goals

- No change to `kizuki.event/v1`.
- No connector contract change.
- No new canon write path.
- No server database.
- No required LLM.
- No silent identity merge.
- No silent canon overwrite.
```

---

## 3.1 TypeScript contracts

```ts
export type Sensitivity =
  | "public"
  | "personal"
  | "private"
  | "unlabeled";

export type Producer =
  | "deterministic"
  | `llm:${string}`
  | `agent:${string}`;

export type NormalizedEventKind =
  | "message"
  | "email"
  | "calendar_event"
  | "audio_segment"
  | "video_segment"
  | "screen_event"
  | "health_sample"
  | "social_post"
  | "file"
  | "note"
  | "tombstone"
  | "other";

export type SubjectRole =
  | "actor"
  | "recipient"
  | "mentioned"
  | "about"
  | "owner"
  | "location"
  | "source_account"
  | "counterparty"
  | "unknown";

export type EntityType =
  | "person"
  | "organization"
  | "project"
  | "place"
  | "account"
  | "device"
  | "household"
  | "artifact"
  | "concept"
  | "unknown";

export interface NormalizedEvent {
  schema: "kizuki.normalized_event/v1";
  normalized_event_id: string;
  event_id: string;
  connector_id: string;
  source_record_id: string;
  content_hash: string;

  kind_raw: string;
  kind_norm: NormalizedEventKind;

  occurred_at: string;
  observed_at: string;

  direction: "inbound" | "outbound" | "self" | "system" | "unknown";
  actor_subject_key?: string;
  conversation_key?: string;
  thread_key?: string;
  parent_event_key?: string;

  text_hash: string;
  language?: string;
  timezone?: string;

  sensitivity_effective: Sensitivity;
  deleted: boolean;

  normalized_json: Record<string, unknown>;
  transform_version: string;
  created_at: string;
}

export interface NormalizedSubjectRef {
  schema: "kizuki.subject_ref/v1";
  subject_ref_key: string;
  event_id: string;
  role: SubjectRole;
  entity_type_hint: EntityType;

  stable_ref_kind:
    | "email"
    | "phone"
    | "handle"
    | "source_user_id"
    | "url"
    | "name"
    | "device_id"
    | "opaque";

  stable_ref_hash: string;
  display_label?: string;
  source_system?: string;
  raw_ref_hash: string;

  sensitivity_floor: Sensitivity;
  confidence: number;
}

export interface EntityCandidate {
  schema: "kizuki.entity_candidate/v1";
  candidate_id: string;
  subject_ref_key: string;
  entity_type: EntityType;
  display_name?: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  confidence: number;
  producer: Producer;
  event_ids: string[];
  candidate_hash: string;
  created_at: string;
}

export interface IdentityLinkCandidate {
  schema: "kizuki.identity_link_candidate/v1";
  link_candidate_id: string;
  left_candidate_id: string;
  right_candidate_id: string;
  relation: "same_as" | "possibly_same_as" | "not_same_as" | "alias_of" | "source_account_for";
  confidence: number;
  evidence: Record<string, unknown>;
  producer: Producer;
  event_ids: string[];
  link_hash: string;
  created_at: string;
}

export type ClaimPredicate =
  | "entity.name"
  | "entity.alias"
  | "contact.email"
  | "contact.phone"
  | "contact.handle"
  | "relationship.knows"
  | "relationship.role"
  | "membership.member_of"
  | "preference.likes"
  | "preference.dislikes"
  | "obligation.open_loop"
  | "obligation.due_at"
  | "event.attended"
  | "event.cancelled"
  | "life.status"
  | `x-${string}`;

export interface ClaimValue {
  kind:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "duration"
    | "subject_ref"
    | "url"
    | "json";
  value: unknown;
}

export interface ClaimAtom {
  schema: "kizuki.claim_atom/v1";
  claim_id: string;
  subject_key: string;
  predicate: ClaimPredicate;
  object: ClaimValue;
  object_hash: string;

  polarity: "asserted" | "negated" | "unknown";
  confidence: number;

  valid_from?: string;
  valid_to?: string;
  valid_precision: "instant" | "day" | "month" | "year" | "range" | "unknown";

  transaction_at: string;

  supersedes_claim_id?: string;
  derived_from_claim_ids: string[];

  producer: Producer;
  stage: string;
  sensitivity_effective: Sensitivity;

  event_ids: string[];
  claim_hash: string;
  created_at: string;
}

export interface EvidenceSpan {
  event_id: string;
  byte_start?: number;
  byte_end?: number;
  attachment_id?: string;
  support_kind: "asserts" | "implies" | "contradicts" | "context";
  quote_hash?: string;
  confidence: number;
}

export interface SubjectReviewPacket {
  schema: "kizuki.review_packet/v1";
  proposal_schema: "kizuki.proposal/v1";
  packet_id: string;

  packet_kind:
    | "subject_delta"
    | "identity_resolution"
    | "claim_conflict"
    | "tombstone"
    | "purge_redaction"
    | "rollup";

  subject_key: string;
  sensitivity_effective: Sensitivity;

  title: string;
  summary_md: string;

  event_ids: string[];
  claim_ids: string[];
  proposal_ids: string[];

  content_hash: string;
  producer: Producer;
  created_at: string;
}
```

---

## 3.2 ID rules

```ts
// Pseudocode, deterministic.
id("ne", event.event_id, event.content_hash, transformVersion);
id("sr", canonicalSubjectRef(subjectRef));
id("ec", subject_ref_key, entity_type, canonicalJson(attributes), producerBase);
id("ic", left_candidate_id, right_candidate_id, relation, canonicalJson(evidence));
id("cl", subject_key, predicate, object_hash, valid_from, valid_to, polarity, sourceEventHash);
id("cg", subject_key, predicate, object_hash, valid_from ?? "", valid_to ?? "");
id("rp", subject_key, packet_kind, orderedProposalHashes);
id("pb", orderedPacketIds, orderedProposalIds, expectedCanonRootHash);
```

---

## 3.3 SQLite schema

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS wm_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  rfc TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
```

### Universal provenance

```sql
CREATE TABLE IF NOT EXISTS wm_artifact_events (
  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('source', 'support', 'contradiction', 'context', 'tombstone')
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_type, artifact_id, event_id, role),
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_artifact_events_event
  ON wm_artifact_events(event_id);

CREATE INDEX IF NOT EXISTS idx_wm_artifact_events_artifact
  ON wm_artifact_events(artifact_type, artifact_id);
```

---

## 3.4 Event envelope normalization

```sql
CREATE TABLE IF NOT EXISTS wm_normalized_events (
  normalized_event_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.normalized_event/v1',

  event_id TEXT NOT NULL UNIQUE,
  connector_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,

  kind_raw TEXT NOT NULL,
  kind_norm TEXT NOT NULL CHECK (
    kind_norm IN (
      'message',
      'email',
      'calendar_event',
      'audio_segment',
      'video_segment',
      'screen_event',
      'health_sample',
      'social_post',
      'file',
      'note',
      'tombstone',
      'other'
    )
  ),

  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,

  direction TEXT NOT NULL CHECK (
    direction IN ('inbound', 'outbound', 'self', 'system', 'unknown')
  ),

  actor_subject_key TEXT,
  conversation_key TEXT,
  thread_key TEXT,
  parent_event_key TEXT,

  text_hash TEXT NOT NULL,
  language TEXT,
  timezone TEXT,

  sensitivity_effective TEXT NOT NULL CHECK (
    sensitivity_effective IN ('public', 'personal', 'private', 'unlabeled')
  ),

  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),

  normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_normalized_events_occurred
  ON wm_normalized_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_wm_normalized_events_thread
  ON wm_normalized_events(thread_key);

CREATE INDEX IF NOT EXISTS idx_wm_normalized_events_actor
  ON wm_normalized_events(actor_subject_key);

CREATE INDEX IF NOT EXISTS idx_wm_normalized_events_sensitivity
  ON wm_normalized_events(sensitivity_effective);
```

```sql
CREATE TABLE IF NOT EXISTS wm_event_spans (
  span_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,

  span_kind TEXT NOT NULL CHECK (
    span_kind IN ('sentence', 'paragraph', 'utterance', 'field', 'attachment_ref')
  ),

  byte_start INTEGER,
  byte_end INTEGER,
  attachment_id TEXT,
  text_hash TEXT,
  quote_hash TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_event_spans_event
  ON wm_event_spans(event_id);
```

### Normalization rules

```ts
const sensitivityRank: Record<Sensitivity, number> = {
  public: 0,
  personal: 1,
  private: 2,
  unlabeled: 3,
};

function maxSensitivity(labels: Sensitivity[]): Sensitivity {
  return labels.sort((a, b) => sensitivityRank[b] - sensitivityRank[a])[0] ?? "unlabeled";
}

/**
 * Missing sensitivity_hint becomes "unlabeled".
 * "unlabeled" is never served to MCP/CLI clients.
 */
function effectiveEventSensitivity(input: {
  eventHint?: "public" | "personal" | "private";
  subjectFloors: Sensitivity[];
  attachmentFloors: Sensitivity[];
}): Sensitivity {
  return maxSensitivity([
    input.eventHint ?? "unlabeled",
    ...input.subjectFloors,
    ...input.attachmentFloors,
  ]);
}
```

---

## 3.5 Subject refs, entity candidates, reversible identity

```sql
CREATE TABLE IF NOT EXISTS wm_subject_refs (
  subject_ref_key TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.subject_ref/v1',

  stable_ref_kind TEXT NOT NULL CHECK (
    stable_ref_kind IN (
      'email',
      'phone',
      'handle',
      'source_user_id',
      'url',
      'name',
      'device_id',
      'opaque'
    )
  ),

  stable_ref_hash TEXT NOT NULL,
  display_label TEXT,
  source_system TEXT,
  raw_ref_hash TEXT NOT NULL,

  entity_type_hint TEXT NOT NULL CHECK (
    entity_type_hint IN (
      'person',
      'organization',
      'project',
      'place',
      'account',
      'device',
      'household',
      'artifact',
      'concept',
      'unknown'
    )
  ),

  sensitivity_floor TEXT NOT NULL CHECK (
    sensitivity_floor IN ('public', 'personal', 'private', 'unlabeled')
  ),

  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_subject_refs_stable
  ON wm_subject_refs(stable_ref_kind, stable_ref_hash, source_system);
```

```sql
CREATE TABLE IF NOT EXISTS wm_event_subject_refs (
  event_id TEXT NOT NULL,
  subject_ref_key TEXT NOT NULL,

  role TEXT NOT NULL CHECK (
    role IN (
      'actor',
      'recipient',
      'mentioned',
      'about',
      'owner',
      'location',
      'source_account',
      'counterparty',
      'unknown'
    )
  ),

  raw_ref_json TEXT NOT NULL CHECK (json_valid(raw_ref_json)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,

  PRIMARY KEY (event_id, subject_ref_key, role),

  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_ref_key) REFERENCES wm_subject_refs(subject_ref_key)
);

CREATE INDEX IF NOT EXISTS idx_wm_event_subject_refs_subject
  ON wm_event_subject_refs(subject_ref_key);
```

```sql
CREATE TABLE IF NOT EXISTS wm_entity_candidates (
  candidate_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.entity_candidate/v1',

  subject_ref_key TEXT NOT NULL,

  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'person',
      'organization',
      'project',
      'place',
      'account',
      'device',
      'household',
      'artifact',
      'concept',
      'unknown'
    )
  ),

  display_name TEXT,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),

  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  producer TEXT NOT NULL,
  candidate_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (subject_ref_key) REFERENCES wm_subject_refs(subject_ref_key)
);

CREATE INDEX IF NOT EXISTS idx_wm_entity_candidates_subject
  ON wm_entity_candidates(subject_ref_key);

CREATE INDEX IF NOT EXISTS idx_wm_entity_candidates_type
  ON wm_entity_candidates(entity_type);
```

```sql
CREATE TABLE IF NOT EXISTS wm_identity_link_candidates (
  link_candidate_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.identity_link_candidate/v1',

  left_candidate_id TEXT NOT NULL,
  right_candidate_id TEXT NOT NULL,

  relation TEXT NOT NULL CHECK (
    relation IN (
      'same_as',
      'possibly_same_as',
      'not_same_as',
      'alias_of',
      'source_account_for'
    )
  ),

  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),

  producer TEXT NOT NULL,
  link_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (left_candidate_id) REFERENCES wm_entity_candidates(candidate_id),
  FOREIGN KEY (right_candidate_id) REFERENCES wm_entity_candidates(candidate_id),

  CHECK (left_candidate_id <> right_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_identity_links_left
  ON wm_identity_link_candidates(left_candidate_id);

CREATE INDEX IF NOT EXISTS idx_wm_identity_links_right
  ON wm_identity_link_candidates(right_candidate_id);
```

```sql
CREATE TABLE IF NOT EXISTS wm_identity_link_decisions (
  decision_id TEXT PRIMARY KEY,

  link_candidate_id TEXT NOT NULL,

  decision TEXT NOT NULL CHECK (
    decision IN ('accept', 'reject', 'split', 'defer')
  ),

  decided_by TEXT NOT NULL DEFAULT 'owner',
  decided_at TEXT NOT NULL,
  decision_payload_json TEXT NOT NULL CHECK (json_valid(decision_payload_json)),
  note TEXT,

  FOREIGN KEY (link_candidate_id)
    REFERENCES wm_identity_link_candidates(link_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_identity_decisions_link
  ON wm_identity_link_decisions(link_candidate_id, decided_at);
```

```sql
CREATE VIEW IF NOT EXISTS wm_identity_link_current_decisions AS
SELECT d.*
FROM wm_identity_link_decisions d
WHERE NOT EXISTS (
  SELECT 1
  FROM wm_identity_link_decisions newer
  WHERE newer.link_candidate_id = d.link_candidate_id
    AND (
      newer.decided_at > d.decided_at
      OR (
        newer.decided_at = d.decided_at
        AND newer.decision_id > d.decision_id
      )
    )
);

CREATE VIEW IF NOT EXISTS wm_identity_links_accepted AS
SELECT l.*
FROM wm_identity_link_candidates l
JOIN wm_identity_link_current_decisions d
  ON d.link_candidate_id = l.link_candidate_id
WHERE d.decision = 'accept';
```

---

## 3.6 Atomic claims with bi-temporal validity

```sql
CREATE TABLE IF NOT EXISTS wm_claim_predicates (
  predicate TEXT PRIMARY KEY,

  subject_type TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (
    object_kind IN (
      'string',
      'number',
      'boolean',
      'date',
      'datetime',
      'duration',
      'subject_ref',
      'url',
      'json'
    )
  ),

  cardinality TEXT NOT NULL CHECK (
    cardinality IN ('one', 'many')
  ),

  canon_target TEXT NOT NULL CHECK (
    canon_target IN ('frontmatter', 'body', 'relationship_edge', 'review_only')
  ),

  sensitivity_floor TEXT NOT NULL CHECK (
    sensitivity_floor IN ('public', 'personal', 'private', 'unlabeled')
  ),

  value_schema_json TEXT NOT NULL CHECK (json_valid(value_schema_json)),
  created_at TEXT NOT NULL
);
```

```sql
CREATE TABLE IF NOT EXISTS wm_claim_atoms (
  claim_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.claim_atom/v1',

  subject_key TEXT NOT NULL,
  predicate TEXT NOT NULL,

  object_kind TEXT NOT NULL CHECK (
    object_kind IN (
      'string',
      'number',
      'boolean',
      'date',
      'datetime',
      'duration',
      'subject_ref',
      'url',
      'json'
    )
  ),

  object_json TEXT NOT NULL CHECK (json_valid(object_json)),
  object_hash TEXT NOT NULL,

  polarity TEXT NOT NULL CHECK (
    polarity IN ('asserted', 'negated', 'unknown')
  ),

  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  valid_from TEXT,
  valid_to TEXT,
  valid_precision TEXT NOT NULL CHECK (
    valid_precision IN ('instant', 'day', 'month', 'year', 'range', 'unknown')
  ),

  /*
    Transaction time is append-only.
    Supersession is represented by a new row pointing at an old row.
    No tx_to update is required.
  */
  transaction_at TEXT NOT NULL,

  supersedes_claim_id TEXT,
  supersession_reason TEXT,

  derived_from_claim_ids_json TEXT NOT NULL CHECK (
    json_valid(derived_from_claim_ids_json)
  ),

  producer TEXT NOT NULL,
  stage TEXT NOT NULL,

  sensitivity_effective TEXT NOT NULL CHECK (
    sensitivity_effective IN ('public', 'personal', 'private', 'unlabeled')
  ),

  claim_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,

  FOREIGN KEY (predicate) REFERENCES wm_claim_predicates(predicate),
  FOREIGN KEY (supersedes_claim_id) REFERENCES wm_claim_atoms(claim_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_claim_atoms_subject
  ON wm_claim_atoms(subject_key);

CREATE INDEX IF NOT EXISTS idx_wm_claim_atoms_predicate
  ON wm_claim_atoms(predicate);

CREATE INDEX IF NOT EXISTS idx_wm_claim_atoms_valid
  ON wm_claim_atoms(valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_wm_claim_atoms_transaction
  ON wm_claim_atoms(transaction_at);

CREATE INDEX IF NOT EXISTS idx_wm_claim_atoms_sensitivity
  ON wm_claim_atoms(sensitivity_effective);
```

```sql
CREATE TABLE IF NOT EXISTS wm_claim_subjects (
  claim_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,

  role TEXT NOT NULL CHECK (
    role IN (
      'subject',
      'object',
      'actor',
      'recipient',
      'location',
      'counterparty',
      'mentioned'
    )
  ),

  created_at TEXT NOT NULL,

  PRIMARY KEY (claim_id, subject_key, role),

  FOREIGN KEY (claim_id) REFERENCES wm_claim_atoms(claim_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_claim_subjects_subject
  ON wm_claim_subjects(subject_key);
```

```sql
CREATE TABLE IF NOT EXISTS wm_claim_evidence (
  support_id TEXT PRIMARY KEY,

  claim_id TEXT NOT NULL,
  event_id TEXT NOT NULL,

  support_kind TEXT NOT NULL CHECK (
    support_kind IN ('asserts', 'implies', 'contradicts', 'context')
  ),

  span_json TEXT NOT NULL CHECK (json_valid(span_json)),
  quote_hash TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  created_at TEXT NOT NULL,

  FOREIGN KEY (claim_id) REFERENCES wm_claim_atoms(claim_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_claim_evidence_claim
  ON wm_claim_evidence(claim_id);

CREATE INDEX IF NOT EXISTS idx_wm_claim_evidence_event
  ON wm_claim_evidence(event_id);
```

### Current claim view

```sql
CREATE VIEW IF NOT EXISTS wm_claim_atoms_current AS
SELECT c.*
FROM wm_claim_atoms c
WHERE NOT EXISTS (
  SELECT 1
  FROM wm_claim_atoms newer
  WHERE newer.supersedes_claim_id = c.claim_id
    AND newer.transaction_at <= datetime('now')
);
```

### Temporal query shape

```ts
export interface ClaimQuery {
  subject_key?: string;
  predicate?: ClaimPredicate;

  /**
   * Real-world validity.
   * Example: "what was true on 2026-08-01?"
   */
  as_of_valid?: string;

  /**
   * Knowledge-state validity.
   * Example: "what did Kizuki know on 2026-08-01?"
   */
  as_of_transaction?: string;

  sensitivity_ceiling: Exclude<Sensitivity, "unlabeled">;
}
```

---

## 3.7 Normalized activities

```sql
CREATE TABLE IF NOT EXISTS wm_activity_candidates (
  activity_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.activity_candidate/v1',

  activity_type TEXT NOT NULL CHECK (
    activity_type IN (
      'conversation',
      'meeting',
      'task',
      'transaction',
      'health_sample',
      'media_capture',
      'screen_session',
      'note_cluster',
      'other'
    )
  ),

  title TEXT,
  primary_subject_key TEXT,

  start_at TEXT NOT NULL,
  end_at TEXT,

  participants_json TEXT NOT NULL CHECK (json_valid(participants_json)),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),

  sensitivity_effective TEXT NOT NULL CHECK (
    sensitivity_effective IN ('public', 'personal', 'private', 'unlabeled')
  ),

  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  producer TEXT NOT NULL,
  activity_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_activity_candidates_time
  ON wm_activity_candidates(start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_wm_activity_candidates_subject
  ON wm_activity_candidates(primary_subject_key);
```

---

## 3.8 Semantic reduction stages

| Stage | Name | Input | Output | Deterministic fallback |
|---:|---|---|---|---|
| 0 | Envelope normalization | `events` | `wm_normalized_events`, `wm_event_subject_refs`, spans | Required. No LLM path. |
| 1 | Activity grouping | normalized events | `wm_activity_candidates` | Thread IDs, source IDs, time windows, participants. |
| 2 | Entity candidate extraction | events, subjects, spans | `wm_entity_candidates` | Email, phone, handle, URL, source user ID, exact display name. |
| 3 | Identity link candidates | entity candidates | `wm_identity_link_candidates` | Exact stable refs only. No fuzzy auto-merge. |
| 4 | Claim atomization | normalized events, activities, candidates | `wm_claim_atoms` | Rule templates, regex, connector metadata, calendar fields, deterministic open-loop heuristics. |
| 5 | Claim grouping/conflict | claim atoms | `wm_claim_group_revisions` | Hash grouping by subject/predicate/object/valid interval; contradiction by predicate/cardinality. |
| 6 | Subject packet build | claim groups, tombstones, identity links | `wm_review_packets` | Deterministic packet title, source counts, claim list, conflict list. |
| 7 | Proposal emission | review packets | `kizuki.proposal/v1` payloads | Required. No LLM path. |

```sql
CREATE TABLE IF NOT EXISTS wm_reduction_runs (
  run_id TEXT PRIMARY KEY,

  stage INTEGER NOT NULL CHECK (stage >= 0 AND stage <= 7),
  stage_name TEXT NOT NULL,

  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,

  producer TEXT NOT NULL,
  model_ref_hash TEXT,

  deterministic_fallback_used INTEGER NOT NULL CHECK (
    deterministic_fallback_used IN (0, 1)
  ),

  transform_version TEXT NOT NULL,

  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('ok', 'partial', 'skipped', 'failed')
  ),

  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
);

CREATE INDEX IF NOT EXISTS idx_wm_reduction_runs_stage
  ON wm_reduction_runs(stage, finished_at);
```

```sql
CREATE TABLE IF NOT EXISTS wm_stage_outputs (
  run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,

  PRIMARY KEY (run_id, artifact_type, artifact_id),

  FOREIGN KEY (run_id) REFERENCES wm_reduction_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_stage_outputs_artifact
  ON wm_stage_outputs(artifact_type, artifact_id);
```

---

## 3.9 Claim grouping and conflict reduction

```sql
CREATE TABLE IF NOT EXISTS wm_claim_group_revisions (
  group_revision_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.claim_group_revision/v1',

  claim_group_key TEXT NOT NULL,

  subject_key TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_hash TEXT NOT NULL,

  valid_from TEXT,
  valid_to TEXT,

  claim_ids_json TEXT NOT NULL CHECK (json_valid(claim_ids_json)),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),

  support_count INTEGER NOT NULL DEFAULT 0,
  contradiction_count INTEGER NOT NULL DEFAULT 0,

  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  summary_md TEXT NOT NULL,
  reducer TEXT NOT NULL,

  sensitivity_effective TEXT NOT NULL CHECK (
    sensitivity_effective IN ('public', 'personal', 'private', 'unlabeled')
  ),

  content_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_claim_groups_subject
  ON wm_claim_group_revisions(subject_key);

CREATE INDEX IF NOT EXISTS idx_wm_claim_groups_key
  ON wm_claim_group_revisions(claim_group_key, created_at);
```

```sql
CREATE TABLE IF NOT EXISTS wm_claim_conflicts (
  conflict_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.claim_conflict/v1',

  subject_key TEXT NOT NULL,
  predicate TEXT NOT NULL,

  left_claim_id TEXT NOT NULL,
  right_claim_id TEXT NOT NULL,

  conflict_type TEXT NOT NULL CHECK (
    conflict_type IN (
      'cardinality_conflict',
      'temporal_overlap',
      'negation',
      'value_mismatch',
      'source_tombstone'
    )
  ),

  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),

  severity TEXT NOT NULL CHECK (
    severity IN ('low', 'medium', 'high')
  ),

  created_at TEXT NOT NULL,

  FOREIGN KEY (left_claim_id) REFERENCES wm_claim_atoms(claim_id),
  FOREIGN KEY (right_claim_id) REFERENCES wm_claim_atoms(claim_id),

  CHECK (left_claim_id <> right_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_claim_conflicts_subject
  ON wm_claim_conflicts(subject_key);
```

---

## 3.10 Subject-level review packets

```sql
CREATE TABLE IF NOT EXISTS wm_review_packets (
  packet_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.review_packet/v1',
  proposal_schema TEXT NOT NULL DEFAULT 'kizuki.proposal/v1',

  packet_kind TEXT NOT NULL CHECK (
    packet_kind IN (
      'subject_delta',
      'identity_resolution',
      'claim_conflict',
      'tombstone',
      'purge_redaction',
      'rollup'
    )
  ),

  subject_key TEXT NOT NULL,

  title TEXT NOT NULL,
  summary_md TEXT NOT NULL,

  claim_ids_json TEXT NOT NULL CHECK (json_valid(claim_ids_json)),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),

  sensitivity_effective TEXT NOT NULL CHECK (
    sensitivity_effective IN ('public', 'personal', 'private', 'unlabeled')
  ),

  producer TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_review_packets_subject
  ON wm_review_packets(subject_key);

CREATE INDEX IF NOT EXISTS idx_wm_review_packets_kind
  ON wm_review_packets(packet_kind);

CREATE INDEX IF NOT EXISTS idx_wm_review_packets_created
  ON wm_review_packets(created_at);
```

```sql
CREATE TABLE IF NOT EXISTS wm_review_packet_items (
  item_id TEXT PRIMARY KEY,

  packet_id TEXT NOT NULL,

  proposal_id TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK (
    proposal_kind IN (
      'entity',
      'claim',
      'edit',
      'merge',
      'deletion'
    )
  ),

  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  claim_ids_json TEXT NOT NULL CHECK (json_valid(claim_ids_json)),

  item_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,

  FOREIGN KEY (packet_id) REFERENCES wm_review_packets(packet_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wm_review_packet_items_packet
  ON wm_review_packet_items(packet_id);

CREATE INDEX IF NOT EXISTS idx_wm_review_packet_items_proposal
  ON wm_review_packet_items(proposal_id);
```

```sql
CREATE TABLE IF NOT EXISTS wm_review_decisions (
  decision_id TEXT PRIMARY KEY,

  packet_id TEXT NOT NULL,
  item_id TEXT,

  decision TEXT NOT NULL CHECK (
    decision IN (
      'accept',
      'reject',
      'edit',
      'split',
      'merge',
      'defer',
      'needs_more_evidence'
    )
  ),

  decision_payload_json TEXT NOT NULL CHECK (json_valid(decision_payload_json)),
  decided_by TEXT NOT NULL DEFAULT 'owner',
  decided_at TEXT NOT NULL,
  note TEXT,

  FOREIGN KEY (packet_id) REFERENCES wm_review_packets(packet_id),
  FOREIGN KEY (item_id) REFERENCES wm_review_packet_items(item_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_review_decisions_packet
  ON wm_review_decisions(packet_id, decided_at);
```

### Proposal item payload shape

```json
{
  "schema": "kizuki.proposal/v1",
  "proposal_id": "prop_01J...",
  "kind": "claim",
  "producer": "deterministic",
  "event_ids": ["evt_01J..."],
  "content_hash": "sha256:...",
  "payload": {
    "op": "assert_claim",
    "claim_id": "cl_...",
    "subject_key": "sr_...",
    "predicate": "obligation.open_loop",
    "object": {
      "kind": "string",
      "value": "Send follow-up to Alice"
    },
    "valid_from": "2026-09-01T10:30:00Z",
    "valid_to": null,
    "valid_precision": "instant",
    "evidence": [
      {
        "event_id": "evt_01J...",
        "span": {
          "byte_start": 44,
          "byte_end": 82
        },
        "support_kind": "asserts"
      }
    ]
  }
}
```

---

## 3.11 Transactional promotion batches

```sql
CREATE TABLE IF NOT EXISTS wm_promotion_batches (
  batch_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.promotion_batch/v1',

  owner_invoked_at TEXT NOT NULL,
  owner_actor TEXT NOT NULL DEFAULT 'owner',

  packet_ids_json TEXT NOT NULL CHECK (json_valid(packet_ids_json)),
  proposal_ids_json TEXT NOT NULL CHECK (json_valid(proposal_ids_json)),

  expected_canon_root_hash TEXT NOT NULL,
  planned_canon_root_hash TEXT NOT NULL,

  batch_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
```

```sql
CREATE TABLE IF NOT EXISTS wm_promotion_file_ops (
  batch_id TEXT NOT NULL,
  op_index INTEGER NOT NULL,

  op_kind TEXT NOT NULL CHECK (
    op_kind IN ('create', 'replace', 'delete')
  ),

  canon_path TEXT NOT NULL,

  before_sha256 TEXT,
  after_sha256 TEXT,

  before_bytes INTEGER,
  after_bytes INTEGER,

  patch_unified TEXT,
  staged_payload_hash TEXT,

  created_at TEXT NOT NULL,

  PRIMARY KEY (batch_id, op_index),

  FOREIGN KEY (batch_id) REFERENCES wm_promotion_batches(batch_id)
);
```

```sql
CREATE TABLE IF NOT EXISTS wm_promotion_journal (
  journal_id TEXT PRIMARY KEY,

  batch_id TEXT NOT NULL,

  phase TEXT NOT NULL CHECK (
    phase IN (
      'prepared',
      'staged',
      'applied',
      'verified',
      'committed',
      'aborted'
    )
  ),

  manifest_hash TEXT NOT NULL,
  disk_root_hash TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),

  created_at TEXT NOT NULL,

  FOREIGN KEY (batch_id) REFERENCES wm_promotion_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_promotion_journal_batch
  ON wm_promotion_journal(batch_id, created_at);
```

```sql
CREATE TABLE IF NOT EXISTS wm_promoted_claim_receipts (
  receipt_id TEXT PRIMARY KEY,

  batch_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  claim_id TEXT,

  canon_path TEXT NOT NULL,
  canon_anchor TEXT,
  after_sha256 TEXT NOT NULL,

  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  created_at TEXT NOT NULL,

  FOREIGN KEY (batch_id) REFERENCES wm_promotion_batches(batch_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_promoted_claim_once
  ON wm_promoted_claim_receipts(proposal_id, claim_id);
```

### Promotion algorithm

```ts
/**
 * Owner-invoked only.
 * No scheduler may call this.
 */
export async function promoteBatch(input: {
  packetIds: string[];
  proposalIds: string[];
  ownerActor: "owner";
}): Promise<{ batch_id: string }> {
  // 1. Acquire vault file lock.
  // 2. BEGIN IMMEDIATE SQLite transaction.
  // 3. Verify selected proposals have accepted review decisions.
  // 4. Verify every selected proposal has event_ids and sensitivity labels.
  // 5. Verify source events still exist and are not purged.
  // 6. Read current canon file hashes.
  // 7. Compute file ops and planned root hash.
  // 8. Insert wm_promotion_batches.
  // 9. Insert wm_promotion_file_ops.
  // 10. Insert wm_promotion_journal phase='prepared'.
  // 11. COMMIT.
  // 12. Write staged files under .kizuki/tmp/promote/<batch_id>/.
  // 13. fsync staged files.
  // 14. Insert journal phase='staged'.
  // 15. Atomic rename staged files into canon vault.
  // 16. fsync parent directories.
  // 17. Insert journal phase='applied'.
  // 18. Re-hash canon files.
  // 19. Insert journal phase='verified'.
  // 20. Insert wm_promoted_claim_receipts.
  // 21. Insert journal phase='committed'.
  // 22. Release vault file lock.
}
```

### Recovery rule

```ts
export async function recoverPromotion(batch_id: string): Promise<void> {
  // prepared without staged:
  //   remove temp dir; mark aborted.
  //
  // staged without applied:
  //   remove temp dir; mark aborted.
  //
  // applied without committed:
  //   re-hash files.
  //   if hashes match planned ops:
  //     insert verified + receipts + committed.
  //   else:
  //     block serving affected canon paths until owner repair.
}
```

---

## 3.12 Purge and revocation cascade

```sql
CREATE TABLE IF NOT EXISTS wm_purge_plans (
  purge_plan_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'kizuki.purge_plan/v1',

  requested_subject_key TEXT,
  requested_event_ids_json TEXT NOT NULL CHECK (json_valid(requested_event_ids_json)),

  artifact_count INTEGER NOT NULL,
  canon_paths_json TEXT NOT NULL CHECK (json_valid(canon_paths_json)),

  plan_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
```

```sql
CREATE TABLE IF NOT EXISTS wm_purge_plan_items (
  purge_plan_id TEXT NOT NULL,

  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,

  event_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'delete_derived_row',
      'delete_index_row',
      'delete_embedding_row',
      'delete_graph_edge',
      'close_open_proposal',
      'create_canon_redaction_packet',
      'deny_serving_until_review'
    )
  ),

  reason TEXT NOT NULL,

  PRIMARY KEY (purge_plan_id, artifact_type, artifact_id, action),

  FOREIGN KEY (purge_plan_id) REFERENCES wm_purge_plans(purge_plan_id)
);
```

### Purge rule

```ts
/**
 * Purge is physical deletion plus receipt.
 * Canon redaction still goes through owner review/promote.
 * Until reviewed, affected canon paths are denied to serving if their source
 * provenance intersects the purged event set.
 */
export interface PurgeCascade {
  deleteEvents: string[];
  deleteDerivedArtifacts: Array<{
    artifact_type: string;
    artifact_id: string;
  }>;
  closeOpenProposals: string[];
  createReviewPackets: SubjectReviewPacket[];
  denyCanonPathsUntilReview: string[];
}
```

---

## 3.13 Serving contract additions

```ts
export interface ContextPacketRequest {
  query: string;
  agent_id?: string;

  budget_tokens: number;

  sensitivity_ceiling: "public" | "personal" | "private";

  scope_subject_keys?: string[];

  as_of_valid?: string;
  as_of_transaction?: string;

  include: Array<
    | "canon"
    | "derived_claims"
    | "quoted_evidence"
    | "timeline"
    | "graph"
  >;

  canon_only?: boolean;
}
```

```ts
export interface ContextPacketResponse {
  schema: "kizuki.context_packet/v1";

  canon: Array<{
    path: string;
    anchor?: string;
    sensitivity: Exclude<Sensitivity, "unlabeled">;
    excerpt_md: string;
    sources: string[];
  }>;

  derived_claims: Array<{
    claim_id: string;
    subject_key: string;
    predicate: ClaimPredicate;
    object: ClaimValue;
    confidence: number;
    valid_from?: string;
    valid_to?: string;
    event_ids: string[];
  }>;

  quoted_evidence: Array<{
    event_id: string;
    connector_id: string;
    occurred_at: string;
    quote: string;
    tainted: true;
  }>;

  denied: Array<{
    reason:
      | "missing_sensitivity"
      | "above_grant"
      | "purged_source"
      | "unknown_agent"
      | "canon_redaction_pending";
    artifact_type: string;
    artifact_id: string;
  }>;
}
```

---

## 3.14 Initial predicate seed

```sql
INSERT OR IGNORE INTO wm_claim_predicates
(predicate, subject_type, object_kind, cardinality, canon_target, sensitivity_floor, value_schema_json, created_at)
VALUES
('entity.name', 'unknown', 'string', 'one', 'frontmatter', 'personal', '{"type":"string","minLength":1}', datetime('now')),
('entity.alias', 'unknown', 'string', 'many', 'frontmatter', 'personal', '{"type":"string","minLength":1}', datetime('now')),
('contact.email', 'person', 'string', 'many', 'frontmatter', 'private', '{"type":"string","format":"email"}', datetime('now')),
('contact.phone', 'person', 'string', 'many', 'frontmatter', 'private', '{"type":"string"}', datetime('now')),
('contact.handle', 'person', 'json', 'many', 'frontmatter', 'personal', '{"type":"object","required":["network","handle"]}', datetime('now')),
('relationship.knows', 'person', 'subject_ref', 'many', 'relationship_edge', 'personal', '{"type":"string"}', datetime('now')),
('relationship.role', 'person', 'string', 'many', 'body', 'personal', '{"type":"string"}', datetime('now')),
('membership.member_of', 'person', 'subject_ref', 'many', 'relationship_edge', 'personal', '{"type":"string"}', datetime('now')),
('preference.likes', 'person', 'string', 'many', 'body', 'personal', '{"type":"string"}', datetime('now')),
('preference.dislikes', 'person', 'string', 'many', 'body', 'personal', '{"type":"string"}', datetime('now')),
('obligation.open_loop', 'person', 'string', 'many', 'body', 'personal', '{"type":"string"}', datetime('now')),
('obligation.due_at', 'person', 'datetime', 'many', 'body', 'personal', '{"type":"string","format":"date-time"}', datetime('now')),
('event.attended', 'person', 'json', 'many', 'body', 'personal', '{"type":"object","required":["title","occurred_at"]}', datetime('now')),
('event.cancelled', 'person', 'json', 'many', 'body', 'personal', '{"type":"object","required":["title","occurred_at"]}', datetime('now')),
('life.status', 'person', 'string', 'many', 'body', 'private', '{"type":"string"}', datetime('now'));
```

---

## 3.15 Worked example

### Input event

```json
{
  "schema": "kizuki.event/v1",
  "event_id": "evt_01K...",
  "connector_id": "telegram",
  "source_record_id": "chat:123/msg:456",
  "kind": "message",
  "occurred_at": "2026-09-01T10:30:00Z",
  "observed_at": "2026-09-01T10:30:04Z",
  "text": "Alice: remind me to send the partner deck Friday",
  "subjects": [
    {
      "kind": "person",
      "display": "Alice",
      "source_user_id": "123"
    }
  ],
  "sensitivity_hint": "personal",
  "deleted": false,
  "attachments": [],
  "metadata": {
    "chat_id": "123",
    "message_id": "456"
  },
  "content_hash": "sha256:spine-computed"
}
```

### Derived subject ref

```json
{
  "schema": "kizuki.subject_ref/v1",
  "subject_ref_key": "sr_alice_source_user_hash",
  "event_id": "evt_01K...",
  "role": "actor",
  "entity_type_hint": "person",
  "stable_ref_kind": "source_user_id",
  "stable_ref_hash": "sha256:telegram:123",
  "display_label": "Alice",
  "source_system": "telegram",
  "raw_ref_hash": "sha256:raw-subject-json",
  "sensitivity_floor": "personal",
  "confidence": 1
}
```

### Derived claim atom

```json
{
  "schema": "kizuki.claim_atom/v1",
  "claim_id": "cl_open_loop_hash",
  "subject_key": "sr_alice_source_user_hash",
  "predicate": "obligation.open_loop",
  "object": {
    "kind": "string",
    "value": "Send the partner deck"
  },
  "object_hash": "sha256:send-partner-deck",
  "polarity": "asserted",
  "confidence": 0.72,
  "valid_from": "2026-09-01T10:30:00Z",
  "valid_to": null,
  "valid_precision": "instant",
  "transaction_at": "2026-09-01T10:30:05Z",
  "derived_from_claim_ids": [],
  "producer": "deterministic",
  "stage": "claim_atomization:v1",
  "sensitivity_effective": "personal",
  "event_ids": ["evt_01K..."],
  "claim_hash": "sha256:...",
  "created_at": "2026-09-01T10:30:05Z"
}
```

### Review packet item

```json
{
  "schema": "kizuki.proposal/v1",
  "proposal_id": "prop_open_loop_hash",
  "kind": "claim",
  "producer": "deterministic",
  "event_ids": ["evt_01K..."],
  "content_hash": "sha256:...",
  "payload": {
    "op": "assert_claim",
    "claim_id": "cl_open_loop_hash",
    "subject_key": "sr_alice_source_user_hash",
    "predicate": "obligation.open_loop",
    "object": {
      "kind": "string",
      "value": "Send the partner deck"
    },
    "valid_from": "2026-09-01T10:30:00Z",
    "valid_to": null,
    "evidence": [
      {
        "event_id": "evt_01K...",
        "support_kind": "asserts",
        "span": {
          "byte_start": 20,
          "byte_end": 52
        }
      }
    ]
  }
}
```

---

## 3.16 CI invariants for RFC 0001

```ts
export const RFC0001Invariants = [
  "No table in wm_* may create or mutate canon files.",
  "Every wm_claim_atom must have at least one wm_claim_evidence row.",
  "Every wm_review_packet must have at least one event_id.",
  "No artifact with sensitivity_effective='unlabeled' may be returned by serving.",
  "No identity link may become accepted without wm_identity_link_decisions.decision='accept'.",
  "No proposal may omit event_ids.",
  "No promotion batch may commit without accepted review decisions.",
  "No promotion file op may apply if before_sha256 does not match disk.",
  "No LLM output may be stored unless it validates against the deterministic schema.",
  "Replaying the same ledger with the same transform_version must produce the same derived content hashes."
] as const;
```

---

## 3.17 Minimal implementation order

```txt
0001-a: schema migration + deterministic ID helpers
0001-b: normalized events + subject_ref normalization
0001-c: entity candidates + exact identity links
0001-d: claim predicate registry + claim atoms + evidence spans
0001-e: claim grouping + conflict detection
0001-f: subject review packets + proposal payloads
0001-g: promotion batch journal + file hash recovery
0001-h: purge cascade planner
0001-i: serving temporal filters + sensitivity fail-closed checks
0001-j: doctor receipts + rebuild/idempotency tests
```
