# RFC 0004, Appendix B: domain contracts

Status: **Appendix to RFC 0004, Proposed; not accepted and not implemented.** Written 2026-09-29. Nothing here is a shipped surface, a migration or a claim about the current revision. Decision D22 item (b) accepted only the Concept slice and a minimal Situation card; everything below stays a proposal until the owner records a decision (see the [proposed decision rows](../docs/world/decisions-proposed.md)).

This is the domain contract appendix that decision D22 item (c) presupposes: "the remaining #497 packets continue on the same contracts". [RFC 0004](0004-living-epistemic-world-model.md) defines the Concept card, the view state machine and the envelope. It defines no contract for questions, people, skills, commitments, artifacts, outcomes, slices, diffs, attention, forecasts, atlas views or the resume handle. This appendix supplies them so that each implementer reuses one shape instead of inventing a parallel one. The [amendment record in RFC 0004](0004-living-epistemic-world-model.md#amendments) lists where these contracts change the RFC text. [Appendix A](0004-world-storage.md) still owns storage and codec bytes.

## Reading rules

- The contracts are design sketches, not exported runtime symbols, in the same convention as RFC 0004. The type sketches fix meaning, closed keys and bounds. They do not fix file names.
- A workstream that implements a contract cites its section here and states every place it deviates. A deviation needs an amendment, not a private variation.
- Every contract obeys the binding decisions: no owner review queue or approval step (D9, D10), automatic sensitivity (D11), canon writing needs a model while capture, ledger, search, timeline, context, audit and undo work without one (D12), retrieval stays behind a port (D13, D17), the tool count stays ten and the write tools stay `propose` and `correct` (D14), and the inert public grant is unchanged (D18).
- Fixture names refer to files under `rfcs/fixtures`. A fixture is a design oracle. Until a test that calls product code promotes it, it establishes no behavior.

## Shared conventions

### Reused contracts

These are never redefined here: `ObjectRef`, `ClaimRef`, `AdmissionRef`, `EventVersionRef`, `ReceiptRef`, `SnapshotRef`, `ViewToken`, `Relation`, `Perspective`, `Coverage`, `ViewGap`, `ValidQuery`, `KnownAt`, `KnownTime`, `EvidenceRef`, `ViewResult`, `QuotedChunkV2` and `Ref` from [RFC 0004](0004-living-epistemic-world-model.md#exact-proposed-semantic-contracts). The shipped Concept card, Situation card and world vocabulary registry are reused as they are. Claim-v2 semantics and support, the correction writer with receipts and undo, the pre-egress scrubber, packet token budgeting and the notifier port are reused as they are. There is one support lineage function and one conflict rule; a second implementation of either is a defect.

```ts
// Shapes shared by every card in this appendix.
type WorldKindId =
  | "concept"
  | "situation"
  | "question"
  | "person"
  | "skill"
  | "framework"
  | "procedure"
  | "commitment"
  | "decision"
  | "artifact_version";
type Node<K extends WorldKindId> = {
  schema: "kizuki.knowledge-node/v1";
  ref: ObjectRef;
  kind: K;
  classificationClaims: readonly ClaimRef[];
  labels: readonly { text: string; claim: ClaimRef }[];
  resolution: "distinct" | "resolved" | "ambiguous";
};
type IndependentRoots = { count: number } | { count: "unknown" };
type CardKnownAt = { kind: "current" } | { kind: "snapshot"; ref: SnapshotRef };
type ProviderCoverage = {
  kind: WorldKindId | "outcome";
  status: "included" | "unavailable";
  reason: null | "not_landed" | "extraction_off";
};
```

`Node` generalizes the shipped node shape: the RFC fixed `kind` to the literal `concept`, and the shipped Situation slice already widened it. `IndependentRoots.count` comes only from the single lineage function. A copy, a forward, a paraphrase, a generated summary and any evidence whose lineage cannot be established add no root, and `unknown` never satisfies a two-root threshold.

### Kind registration

A kind is data: one registration names its `world.kind` value, its label predicate, its card schema, its read operations and its population path. A registered kind is not offered to the extraction model until a held-out extraction check passes. The `describe` operation of [Amendment 8](0004-living-epistemic-world-model.md#amendment-8-the-world_view-operation-family-and-describe) reports the state, and the state depends only on the build, never on vault contents or counts.

| Kind id          | World kind value         | Label predicate    | Card schema                                            | Read operations                          | Population path                   |
| ---------------- | ------------------------ | ------------------ | ------------------------------------------------------ | ---------------------------------------- | --------------------------------- |
| concept          | `world/concept`          | `concept.label`    | `kizuki.concept-card/v1`                               | `find_concepts`, `concept`               | typed extraction (shipped)        |
| situation        | `world/situation`        | `situation.label`  | `kizuki.situation-card/v1`, `kizuki.situation-card/v2` | `find_situations`, `situation`           | typed extraction (shipped)        |
| question         | `world/question`         | `question.text`    | `kizuki.question-card/v1`                              | `find_questions`, `question`, `frontier` | typed extraction                  |
| person           | `world/person`           | `person.label`     | `kizuki.person-card/v1`                                | `find_people`, `person`                  | structured supplied subject only  |
| skill            | `world/skill`            | `skill.label`      | `kizuki.procedure-card/v1`                             | `skill`                                  | typed extraction                  |
| framework        | `world/framework`        | `framework.label`  | `kizuki.procedure-card/v1`                             | `procedure`                              | typed extraction                  |
| procedure        | `world/procedure`        | `procedure.label`  | `kizuki.procedure-card/v1`                             | `find_procedures`, `procedure`           | typed extraction                  |
| commitment       | `world/commitment`       | `commitment.label` | none of its own; served in the Situation v2 card       | none                                     | typed extraction                  |
| decision         | `world/decision`         | `decision.label`   | none of its own; served in the Situation v2 card       | none                                     | typed extraction                  |
| artifact_version | `world/artifact_version` | `artifact.label`   | `kizuki.artifact-card/v1`                              | `find_artifacts`, `artifact_version`     | connector or import metadata only |

A kind is `shipped` in `describe` when its population path is enabled in the build, and `dark` when the path is `extraction_off` or `none`. A dark kind is still registered and readable: discovery over it returns partial with the gap `coverage`, never complete, so no agent is told that absence means nothing exists. The classification value on a raw subject (for example `world/artifact_version`) is not a new object discriminator of `Relation.object`. A `concept.example` may point at such a subject as an existing supported raw subject ref.

```ts
type WorldDescribe = {
  schema: "kizuki.world-describe/v1";
  vocabulary: "kizuki.world-vocabulary/v1";
  kinds: readonly {
    id: WorldKindId;
    state: "shipped" | "dark";
    population:
      | "typed_extraction"
      | "extraction_off"
      | "supplied_subject"
      | "connector_metadata"
      | "propose"
      | "none";
  }[];
  operations: readonly {
    name: string;
    inputKeys: readonly string[];
    resultSchemas: readonly string[];
  }[];
};
```

Vocabulary additions keep the identifier `kizuki.world-vocabulary/v1`, and existing rows are pinned: a test fails if the meaning of an existing predicate changes without a new identifier. New rows are additive and arrive one kind at a time.

### Codec rules

- Every card, view and result is a closed object. A parser rejects extra keys, wrong types, oversize arrays and malformed refs. A new card is built from the shared card kit (relation, coverage, wire-ref and node validators), not from copies of them.
- Only wire refs appear in a scoped result. No raw page path, source key, event id, claim id, receipt id or semantic key appears in a field, a label or an error.
- Each asserted fact is a `Relation`, so perspective, valid time, assessments and conflict travel with it. A card never flattens who said what into one value.
- Every operation result is a `ViewResult<T>`. `unchanged` and view tokens exist only for complete results. Response bounds are those of RFC 0004: at most 128 candidate claims, 256 traversed raw refs, 1,024 edges, depth 4 and 256 KiB per response.
- An incompatible change to a shipped card is a new schema id and an opt-in input. The old card stays byte-identical for existing clients.
- Hidden evidence changes no output byte, error or work counter for a principal that cannot read it. A marker that would reveal hidden state (a count, an omission notice, a partial flag caused by a hidden endpoint) is never emitted.

### Gaps, fallbacks and providers

The `ViewGap` union stays closed: `coverage`, `pending_consolidation`, `stale_dependencies`, `required_context_overflow` and `traversal_limit`. This appendix adds none. Each contract states which gaps it uses on a `Gap use` line. Where a surface cannot be honest yet it returns an explicit value with a reason: `unavailable`, partial coverage, a pending or stale gap, `baseline_only`, `unknown` or `not_found`. It never returns an empty complete result, a zero or a default. A composed operation reports each provider it needed through `ProviderCoverage` inside its coverage, so a missing provider is listed as `unavailable` and never silently omitted.

### Independence, usefulness and truth

Independent support, truth confidence and usefulness are three separate things. Outcome evidence can move usefulness. It never raises a claim's confidence, never lowers it and never overrides an owner correction. Retrieval frequency, mention count and volume raise nothing. No operation in this appendix executes, schedules or sends anything. Text that looks like an instruction stays untrusted data.

### Schema ids introduced here

| Schema id                     | Contract                                  | Status   |
| ----------------------------- | ----------------------------------------- | -------- |
| `kizuki.world-describe/v1`    | Kind registration, `describe` output      | Proposed |
| `kizuki.situation-card/v1`    | Shipped minimal Situation card, unchanged | Shipped  |
| `kizuki.situation-card/v2`    | Situation v2                              | Proposed |
| `kizuki.question-card/v1`     | Question                                  | Proposed |
| `kizuki.question-frontier/v1` | Question                                  | Proposed |
| `kizuki.person-card/v1`       | Person                                    | Proposed |
| `kizuki.procedure-card/v1`    | Skill, Framework, Procedure               | Proposed |
| `kizuki.artifact-card/v1`     | ArtifactVersion                           | Proposed |
| `kizuki.outcome-card/v1`      | Outcome                                   | Proposed |
| `kizuki.world-slice/v1`       | WorldSlice                                | Proposed |
| `kizuki.world-diff/v1`        | WorldDiff                                 | Proposed |
| `kizuki.atlas-view/v1`        | Atlas                                     | Proposed |
| `kizuki.resume-handle/v1`     | ResumeHandle                              | Proposed |
| `kizuki.attention/v1`         | Attention                                 | Proposed |
| `kizuki.forecast/v1`          | Forecast                                  | Proposed |
| `kizuki.forecast-scores/v1`   | Forecast                                  | Proposed |

## Domain kinds

### Question

A question is a node with attributed text, candidate answers and gaps. Its lifecycle is derived from claims and never stored.

```ts
type GapKind = "unanswered" | "conflicting" | "thin_evidence" | "stale";
type QuestionLifecycle =
  "open" | "partial" | "resolved" | "reopened" | "abandoned";
type QuestionCard = {
  schema: "kizuki.question-card/v1";
  question: Node<"question">;
  text: Relation | null;
  lifecycle: QuestionLifecycle;
  lifecycleBasis: readonly ClaimRef[];
  candidateAnswers: readonly {
    answer: Relation;
    independentRoots: IndependentRoots;
    resolves: boolean;
  }[];
  independentCorroboration: IndependentRoots;
  motivates: readonly Relation[];
  gaps: readonly { kind: GapKind; about: ObjectRef | null; claim: ClaimRef }[];
  knownAt: CardKnownAt;
  coverage: Coverage;
};
type QuestionFrontier = {
  schema: "kizuki.question-frontier/v1";
  groups: readonly {
    kind: GapKind;
    questions: readonly {
      question: ObjectRef;
      about: ObjectRef | null;
      lifecycle: QuestionLifecycle;
    }[];
  }[];
  coverage: Coverage;
};
```

| Predicate                   | Endpoints and cardinality                                                                                     | Interpretation                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question.text`             | Question to a literal of at most 400 characters; many                                                         | The question in the asker's words; the label predicate of the kind                                                                                                                 |
| `question.status`           | Question to vocabulary `question/open`, `question/partial`, `question/resolved` or `question/abandoned`; many | An attributed status assertion, an input to the derived lifecycle and never the lifecycle itself. `question/reopened` is a projection value only and is refused as a stored object |
| `question.candidate_answer` | Question to a literal or a supported raw subject ref; many                                                    | A proposed answer with its own evidence. A candidate never resolves a question by existing                                                                                         |
| `question.motivates`        | Question to a Concept or Situation node; many                                                                 | The work the question is asked in service of; it does not claim that work exists                                                                                                   |
| `gap.kind`                  | Question to vocabulary `gap/unanswered`, `gap/conflicting`, `gap/thin_evidence` or `gap/stale`; many          | Why the question is a knowledge gap                                                                                                                                                |
| `gap.about`                 | Question to a Concept or Situation node; many                                                                 | Which node the gap concerns                                                                                                                                                        |

**Rules:**

- With no status claim the lifecycle is `open`. A live status claim sets it, and the highest-authority live status claim wins, so an owner assertion of `question/abandoned` or `question/resolved` outranks a model assertion. A `resolved` question becomes `reopened` when a live claim of opposite polarity contradicts its resolving answer under the shared conflict rule. `abandoned` is never counted as resolved, and silence never resolves a question.
- A candidate answer that is a copy of another adds no independent root. A copied model answer beside one independent partial note leaves `independentCorroboration` at one and the lifecycle `open`.
- The card has no curiosity, importance or urgency field. Mention frequency is never an input.
- The frontier lists at most 128 questions across its groups, ordered by gap kind in the order the type lists them and then by stable ref. It is partial with the gap `coverage` while source coverage has gaps or while the producer does not yet extract questions.
- The Concept and Situation cards are unchanged. Questions about a concept are found through `find_questions` with an `about` filter.

**Delivered by:** the questions workstream, operations `find_questions`, `question` and `frontier`.

**Oracle fixtures:** `world-question-copy`, `world-question-reopen`

**Gap use:** `coverage`, `pending_consolidation`

**Fallback:** Discovery for a Question kind that is registered but not offered to extraction, and that has no claims, returns partial with the gap `coverage`, never complete. When extraction has never run for a visible source the answer is partial with `pending_consolidation`.

### Person

A person node is created only from a structured supplied subject. Its card groups what is said by who said it.

```ts
type PersonCard = {
  schema: "kizuki.person-card/v1";
  person: Node<"person">;
  roles: readonly Relation[];
  relationships: readonly Relation[];
  perspectives: readonly {
    holder: ObjectRef | null;
    speaker: ObjectRef | null;
    mode: Perspective["mode"];
    relations: readonly Relation[];
  }[];
  knownAt: CardKnownAt;
  coverage: Coverage;
};
```

| Predicate           | Endpoints and cardinality                    | Interpretation                                                                                        |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `person.label`      | Person to a literal; many                    | A name as stated. An alias candidate that never establishes identity; the label predicate of the kind |
| `person.role`       | Person to a literal; many, valid-time scoped | A role or title with its own validity interval                                                        |
| `relationship.with` | Person to Person; many, valid-time scoped    | A stated relationship. An ended relationship is ended now and active at an earlier valid time         |

**Rules:**

- A Person node exists only when a structured supplied subject ref is bound. Text alone never creates one; a name in prose is at most a literal.
- A Person card never merges two people. Two people with the same label stay two nodes and resolution is reported as `ambiguous`.
- `perspectives` groups relations by the triple (holder, speaker, mode). A null holder stays null and never defaults to the owner. There is no field that says two holders agree. Two deadlines stated by two holders stay two entries.
- A relation whose other endpoint the reader may not read is omitted with no marker, no count and no partial flag caused by it.
- Correcting the owner's belief about a person is an owner-perspective claim. It leaves the historical quotation and the other person's statement intact.

**Delivered by:** the people workstream, operations `find_people` and `person`.

**Oracle fixtures:** `world-perspective-binding`, `rich-subject-quoted-disagreement`, `rich-subject-homonym`

**Gap use:** `coverage`, `traversal_limit`

**Fallback:** With no supplied subject bound, discovery returns partial with the gap `coverage`, not an empty complete result. A relationship whose valid time is unknown cannot satisfy an `at` or `overlap` filter and appears only under `unknown_only` or `all`.

### Skill

A skill is read-only knowledge about evidence that a person can do something. Evidence stages are separate facets, never a ladder and never a score.

```ts
type SkillEvidenceStage =
  | "self_report"
  | "exposure"
  | "explanation"
  | "application"
  | "observed_outcome";
type SkillEvidence = {
  stage: SkillEvidenceStage;
  relation: Relation; // the actor and task context are the Relation's context
  assistance: "assisted" | "unassisted" | "unknown";
  independentRoots: IndependentRoots;
};
```

| Predicate        | Endpoints and cardinality                                                                                                             | Interpretation                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `skill.label`    | Skill to a literal; many                                                                                                              | The skill's name as stated; the label predicate of the kind                                                |
| `skill.evidence` | Skill to vocabulary `skill/self_report`, `skill/exposure`, `skill/explanation`, `skill/application` or `skill/observed_outcome`; many | One stage of evidence that the actor named in the Relation context has the skill, in that context and time |

**Rules:**

- Retrieval count raises nothing. Assisted work is not independent mastery, and exposure alone never yields `application` or `observed_outcome`.
- The reader lists a `skill/observed_outcome` assertion at that stage only when the independence test of the [Outcome contract](#outcome) passes for its provenance. Otherwise it lists the assertion as `skill/self_report`.
- The older registered predicate `skill.has` stays a legacy v1 claim and is read as it is today.

**Delivered by:** the skills workstream, operation `skill`, which returns the [procedure card](#procedure).

**Oracle fixtures:** `world-outcome-mastery`, `world-procedure-evidence`

**Gap use:** `coverage`, `traversal_limit`

**Fallback:** A skill with no independent outcome evidence reports usefulness as unknown with reason `no_outcome_evidence`; it lists no success rows.

### Framework

A framework is a named container of other frameworks, procedures and skills. Containment is stated, direct and acyclic.

```ts
type FrameworkView = {
  includes: readonly Relation[]; // direct containment stated by evidence
  includedIn: readonly Relation[]; // the reverse edges the reader may read
};
```

| Predicate            | Endpoints and cardinality                               | Interpretation                                                                                                                                  |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework.label`    | Framework to a literal; many                            | The framework's name as stated; the label predicate of the kind                                                                                 |
| `framework.includes` | Framework to a Framework, Procedure or Skill node; many | A stated containment. Acyclic: a claim that would close a cycle is refused with `world_cycle` at write and is ignored with a stated gap at read |

**Rules:**

- Nesting is kept. A framework that includes a framework that includes a method lists the direct edge at each level. The transitive edge is never stored. A reader that wants the closure walks it within the depth bound of 4 and reports the gap `traversal_limit` beyond it.
- A containment claim from a source is attributed like any other relation. It does not prove the contained item belongs to the container in the real world.

**Delivered by:** the skills workstream, operation `procedure`, which returns the [procedure card](#procedure) for a Framework node.

**Oracle fixtures:** `rich-subject-nested-frameworks`

**Gap use:** `coverage`, `traversal_limit`

**Fallback:** When containment exceeds the depth bound the card is incomplete with the gap `traversal_limit`, never a complete-looking truncated tree.

### Procedure

A procedure is read-only knowledge. Its card reports four separate dimensions and never a single score: evidence strength, task usefulness, applicability and freshness.

```ts
type Usefulness =
  | { status: "unknown"; reason: "no_outcome_evidence" }
  | {
      status: "observed";
      direction: "up" | "down" | "mixed";
      assistance: "assisted" | "unassisted" | "unknown";
      outcomes: readonly ClaimRef[];
    };
type ProcedureCard = {
  schema: "kizuki.procedure-card/v1";
  node: Node<"procedure"> | Node<"skill"> | Node<"framework">;
  procedure: {
    untrusted: true;
    steps: readonly Relation[];
    prerequisites: readonly Relation[];
    appliesTo: readonly Relation[];
    counterexamples: readonly Relation[];
    lastValidated: readonly Relation[];
  } | null;
  skill: { evidence: readonly SkillEvidence[] } | null;
  framework: FrameworkView | null;
  evidenceStrength: {
    independentRoots: IndependentRoots;
    assistance: "assisted" | "unassisted" | "unknown" | "mixed";
  };
  usefulness: Usefulness;
  applicability: { limits: readonly Relation[] };
  freshness: { observedAt: string | null; lastValidatedAt: string | null };
  knownAt: CardKnownAt;
  coverage: Coverage;
};
```

| Predicate                  | Endpoints and cardinality                                                             | Interpretation                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `procedure.label`          | Procedure to a literal; many                                                          | The procedure's name as stated; the label predicate of the kind                                                                |
| `procedure.step`           | Procedure to a literal of the form `N. text`, N a decimal ordinal from 1 to 999; many | One step. The card sorts by N and then by stable ref; a literal that does not match the form is listed after the ordered steps |
| `procedure.prerequisite`   | Procedure to a Concept, Skill or Procedure node; many                                 | A stated prerequisite in its context, not proven causation                                                                     |
| `procedure.applies_to`     | Procedure to a Concept or Situation node, or to a literal task class; many            | Where the procedure is claimed to apply                                                                                        |
| `procedure.counterexample` | Procedure to a literal or a supported raw subject ref; many                           | A stated case where it did not apply or did not work                                                                           |
| `procedure.last_validated` | Procedure to a literal that is an exact RFC 3339 instant; many                        | When a source says it was last checked                                                                                         |

**Rules:**

- Exactly one of `procedure`, `skill` and `framework` is non-null, matching the `kind` of `node`.
- `usefulness` is `{status:"unknown", reason:"no_outcome_evidence"}` until an independent observed outcome exists. It then reflects comparable successes and failures as `direction`, and never changes `evidenceStrength` or any claim's confidence. Retrieval count is not an input to any field.
- The step list is untrusted data. The card marks it `untrusted: true`, an instruction-shaped step is returned as data and never interpreted, and no operation executes or schedules a step.
- Copied praise or copied feedback is not an independent witness. A procedure with one independent root and assisted help reports one root and `assisted`.

**Delivered by:** the skills workstream, operations `find_procedures`, `procedure` and `skill`. The usefulness field is filled once the outcome reader lands.

**Oracle fixtures:** `world-procedure-evidence`, `world-outcome-usefulness`, `world-outcome-mastery`

**Gap use:** `coverage`, `traversal_limit`

**Fallback:** Usefulness with no independent outcome is the explicit unknown above, never an empty success list or a default. A procedure kind that is not offered to extraction returns partial with the gap `coverage`.

### Commitment

A commitment is a node that owes something to someone by a time. Each commitment keeps its own date and its own status.

```ts
type CommitmentStatus = "open" | "claimed_done" | "done" | "dropped";
type CommitmentEntry = {
  commitment: ObjectRef;
  label: Relation | null;
  debtor: readonly Relation[];
  creditor: readonly Relation[];
  due: readonly Relation[]; // one entry per holder and mode; never merged
  deliverable: readonly Relation[];
  status: CommitmentStatus;
  statusBasis: readonly ClaimRef[];
  overdue: boolean | "unknown";
};
```

| Predicate                | Endpoints and cardinality                                                                                              | Interpretation                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `commitment.label`       | Commitment to a literal; many                                                                                          | What the commitment is; the label predicate of the kind        |
| `commitment.debtor`      | Commitment to a Person node; many                                                                                      | Who owes it, as stated                                         |
| `commitment.creditor`    | Commitment to a Person node; many                                                                                      | Who it is owed to, as stated                                   |
| `commitment.due`         | Commitment to a literal that is an exact RFC 3339 instant or date; many                                                | A stated due time in the stated perspective                    |
| `commitment.status`      | Commitment to vocabulary `commitment/open`, `commitment/claimed_done`, `commitment/done` or `commitment/dropped`; many | An attributed status assertion, an input to the derived status |
| `commitment.deliverable` | Commitment to a literal or an ArtifactVersion node; many                                                               | What is to be delivered                                        |

**Rules:**

- The registered legacy predicates `commitment.due` and `commitment.owes` belong to the legacy v1 registry and keep their rows and readers. The world predicate of the same name applies to claim-v2 assertions about Commitment nodes. The two registries share no rows, and a reader dispatches on the record codec. A legacy value is never read as a Commitment due time.
- Two commitments keep independent dates. Correcting the date of one leaves the other untouched. There is no agreed-date field: two holders' dates stay two entries in `due`.
- The displayed status is `done` only when an independent observation of the deliverable's criterion is met under the [Outcome contract](#outcome) or an owner-authority claim says `commitment/done`. A `commitment/done` from anyone else is displayed as `claimed_done`.
- `overdue` is `unknown` when no due time exists, when source coverage is incomplete, or when two holders' due times disagree. It is `true` or `false` only with complete coverage and a single due time.

**Delivered by:** the situations workstream. Commitment nodes are served inside the [Situation v2](#situation-v2) card and inside slices and atlas views. There is no read operation of their own.

**Oracle fixtures:** `world-commitment-binding`, `world-longitudinal-design`

**Gap use:** `coverage`, `pending_consolidation`, `traversal_limit`

**Fallback:** An unknown or unstated due time gives `overdue: "unknown"`. A commitment whose completion has only a self-report displays `claimed_done`, never `done`.

### Decision

A decision is a node that records that something was chosen. A suggestion, an idea or a question about a choice is not a decision.

```ts
type DecisionStatus = "open" | "decided" | "reversed";
type DecisionEntry = {
  decision: ObjectRef;
  label: Relation | null;
  status: DecisionStatus;
  statement: Relation; // the asserted-mode status claim that admits it as a decision
};
```

| Predicate         | Endpoints and cardinality                                                               | Interpretation                                                        |
| ----------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `decision.label`  | Decision to a literal; many                                                             | What was decided or is to be decided; the label predicate of the kind |
| `decision.status` | Decision to vocabulary `decision/open`, `decision/decided` or `decision/reversed`; many | An attributed status assertion                                        |

**Rules:**

- A decision is listed in `decisions` only while its status claim is in asserted mode. A claim in the `suggested`, `hypothetical`, `questioned` or `uncertain` mode is listed under the card's `uncertainty` instead. Reclassifying an asserted decision claim to one of those modes through a correction moves it there, and undoing the correction restores it.
- A quoted or reported decision stays in its holder's perspective. A later decision does not silently reverse an earlier one: reversal needs an explicit `decision/reversed` claim.
- The registered legacy predicates `decision.decided` and `decision.rejected` stay legacy v1 claims.

**Delivered by:** the situations workstream, inside the [Situation v2](#situation-v2) card.

**Oracle fixtures:** `world-commitment-binding`, `world-longitudinal-design`

**Gap use:** `coverage`, `pending_consolidation`

**Fallback:** A decision known only from a non-asserted mode is shown as uncertainty and never as a decision.

### Situation v2

Situation v2 is an opt-in card. The shipped v1 card stays byte-identical for every existing client. The input key `card` on the `situation` operation selects `kizuki.situation-card/v2`; without it the operation returns v1.

Shipped Situation vocabulary, recorded here because RFC 0004 did not list it:

| Predicate               | Endpoints and cardinality                              | Interpretation                                        |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `situation.label`       | Situation to a literal of at most 400 characters; many | The situation's name; the label predicate of the kind |
| `situation.objective`   | Situation to a literal; many                           | A stated objective                                    |
| `situation.commitment`  | Situation to a literal; many                           | A stated commitment that has no Commitment node       |
| `situation.blocker`     | Situation to a literal; many                           | A stated blocker                                      |
| `situation.change`      | Situation to a literal; many                           | A stated recent change                                |
| `situation.participant` | Situation to a supported raw subject ref; many         | A participant as stated                               |

Additions:

| Predicate                  | Endpoints and cardinality                                            | Interpretation                                |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| `situation.has_commitment` | Situation to a Commitment node; many                                 | Which commitments belong to the situation     |
| `situation.has_decision`   | Situation to a Decision node; many                                   | Which decisions belong to the situation       |
| `situation.requires`       | Situation to a Situation, Commitment or Decision node; many, acyclic | A stated dependency in its context            |
| `situation.enables`        | Situation to a Situation, Commitment or Decision node; many, acyclic | A stated enabling relation                    |
| `situation.blocks`         | Situation to a Situation, Commitment or Decision node; many, acyclic | A stated blocking relation                    |
| `situation.invalidated_by` | Situation to a Situation, Commitment, Decision node or literal; many | A stated reason the situation no longer holds |

```ts
type SituationCardV2 = Omit<SituationCard, "schema" | "commitments"> & {
  schema: "kizuki.situation-card/v2";
  commitments: readonly CommitmentEntry[];
  statedCommitments: readonly Relation[]; // v1 literal commitments with no node
  decisions: readonly DecisionEntry[];
  dependencies: readonly {
    predicate:
      | "situation.requires"
      | "situation.enables"
      | "situation.blocks"
      | "situation.invalidated_by";
    from: ObjectRef;
    to: ObjectRef;
    relation: Relation;
  }[];
};
```

**Rules:**

- `SituationCard` is the shipped `kizuki.situation-card/v1` codec. V2 changes only the commitment field and adds `statedCommitments`, `decisions` and `dependencies`.
- A blocked dependency surfaces with its evidence. A dependency cycle in `situation.requires`, `situation.enables` or `situation.blocks` is refused with `world_cycle` at write and is reported as a gap at read.
- The session-start context sections that render commitments read this card. There is one projection source for commitments, not two collectors.

**Delivered by:** the situations workstream.

**Oracle fixtures:** `world-commitment-binding`, `world-longitudinal-design`

**Gap use:** `coverage`, `pending_consolidation`, `stale_dependencies`, `traversal_limit`

**Fallback:** A Situation whose commitments were never extracted into nodes returns them in `statedCommitments` from the v1 claims. A request for v2 never fails a v1-only vault: it returns a v2 card with empty node lists and the gap `coverage`.

### ArtifactVersion

An artifact version is exact-version metadata bound to a captured digest. Kizuki owns no artifact bytes in this slice and never claims to have inspected them.

```ts
type ArtifactCard = {
  schema: "kizuki.artifact-card/v1";
  artifact: Node<"artifact_version">;
  versionOf: Relation | null;
  content: {
    sha256: string | null;
    mediaType: string | null;
    byteLength: number | null;
  };
  original: { status: "unavailable" } | { status: "external" };
  inspections: readonly Relation[]; // feedback bound to exactly this version
  knownAt: CardKnownAt;
  coverage: Coverage;
};
```

| Predicate                 | Endpoints and cardinality                                                 | Interpretation                                          |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `artifact.label`          | ArtifactVersion to a literal; many                                        | A name for the version; the label predicate of the kind |
| `artifact.content_sha256` | ArtifactVersion to a literal of 64 lowercase hexadecimal characters; many | The content digest of exactly this version              |
| `artifact.media_type`     | ArtifactVersion to a literal; many                                        | The stated media type                                   |
| `artifact.byte_length`    | ArtifactVersion to a literal decimal integer; many                        | The stated byte length                                  |
| `artifact.version_of`     | ArtifactVersion to a supported raw subject ref; many                      | The logical artifact this is a version of               |
| `artifact.feedback`       | ArtifactVersion to a literal or a supported raw subject ref; many         | A critique or inspection bound to this exact version    |

**Rules:**

- The digest, media type and byte length come only from event metadata mapped by a connector or an import path. A producer response that names them is refused. A model-supplied digest is never accepted. Frozen `kizuki.event/v1` is unchanged.
- Different digests never merge into one version, and feedback on one version never attaches to another.
- The same bytes seen through two sources keep each source's own policy. No annotation, permission or evidence unions across sources.
- `original` is `unavailable` or `external`. The card has no field that claims visual inspection or possession of bytes.
- Purging a source removes the artifact's claims and refs that depend on it.

**Delivered by:** the artifacts workstream, operations `find_artifacts` and `artifact_version`.

**Oracle fixtures:** `world-artifact-binding`, `world-artifact-content-binding`, `world-artifact-text-region`

**Gap use:** `coverage`

**Fallback:** With no connector or import path that supplies digests, the cards are empty and describe reports the kind through its population path. The documentation names which sources supply digests.

## Execution outcomes

### Outcome

Execution outcomes enter only through the existing `propose` tool as registered legacy claims. There is no new tool and no typed execution-receipt arm. Reads grant no execution authority.

```ts
type OutcomeObservation = "met" | "not_met" | "confounded" | "inconclusive";
type OutcomeReview = "accepted" | "rejected" | "pending";
type OutcomeStage = { claim: ClaimRef; independent: boolean | "unknown" };
type OutcomeCard = {
  schema: "kizuki.outcome-card/v1";
  stages: {
    agentReported: readonly OutcomeStage[];
    providerAcknowledged: readonly OutcomeStage[];
    observed: readonly (OutcomeStage & { value: OutcomeObservation })[];
    reviewed: readonly (OutcomeStage & { value: OutcomeReview })[];
  };
  goalAchieved: boolean;
  knownAt: CardKnownAt;
  coverage: Coverage;
};
```

| Predicate              | Endpoints and cardinality                                                              | Interpretation                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `outcome.self_report`  | Person or project to a bounded string; many                                            | The reporting agent says the work is done. Never independent                                                                       |
| `outcome.provider_ack` | Person or project to a bounded string; many                                            | A provider acknowledged receipt or acceptance. Not the goal                                                                        |
| `outcome.observation`  | Person or project to the string `met`, `not_met`, `confounded` or `inconclusive`; many | An attributable observation against a stated criterion. `confounded` and `inconclusive` are distinct from failure and from success |
| `outcome.review`       | Person or project to the string `accepted`, `rejected` or `pending`; many              | A review of the result                                                                                                             |

**Rules:**

- The four predicates are added to the registered legacy predicate registry (kind claim, provenance events the caller can read). The predicates `outcome.reached` and `outcome.missed` stay registered and are read as self reports.
- The legacy registry does not enumerate object values. The reader parses the closed sets above. A stored object outside the set reads as `inconclusive` for an observation and `pending` for a review, never as success.
- An entry is independent only when its principal differs from the reporter's and its provenance source differs from the reporter's, judged by the lineage function. A forwarded copy, the reporter's own second claim and a provider acknowledgement of the reporter's own claim are not independent.
- `goalAchieved` is true only when the latest independent observation is `met` and the latest independent review is `accepted`. An absent or pending review makes it false. Earlier entries stay listed: a later correct artifact does not rewrite an earlier failed inspection.
- An identical idempotent claim is one logical result, and a replayed report adds no entry.
- The card is addressed by the `ClaimRef` of any outcome claim in the group; the group is the readable outcome claims that share that claim's subject. A card never merges outcomes across subjects.
- Comparable success moves the `usefulness` of a Procedure or Skill up and comparable failure moves it down. Confounded and inconclusive observations move nothing. Truth confidence and owner corrections are untouched.
- A grant without `propose`, a subject outside the grant or missing provenance is refused before mutation with an audit row. Purging a provenance source removes derived outcome entries, and restore resurrects nothing.

**Delivered by:** the outcomes workstream: predicate registration, the outcome reader over legacy claims and the `outcome` operation.

**Oracle fixtures:** `world-outcome-stages`, `world-outcome-evidence`, `world-outcome-replay`, `world-outcome-copy`, `world-outcome-confounded`, `world-outcome-usefulness`, `world-outcome-matched-evaluation`, `world-outcome-mastery`, `world-outcome-purge`

**Gap use:** `coverage`

**Fallback:** With no independent observation the card lists only the agent-reported stage and `goalAchieved` is false. With incomplete source coverage the card is partial with the gap `coverage`.

## Composed operations

### WorldSlice

A World Slice is a bounded, evidence-linked task view composed from the kinds whose providers exist. It carries evidence refs and never quoted text. It writes no canon.

```ts
type SliceItem = {
  kind: WorldKindId;
  node: ObjectRef;
  relation: Relation;
  evidence: readonly EvidenceRef[];
};
type SliceInput = {
  operation: "slice";
  task: string; // at most 512 UTF-8 bytes
  kinds?: readonly WorldKindId[];
  budgetTokens: number; // 50 to 2,000
  valid: ValidQuery;
  knownAt: KnownAt;
  priorView?: ViewToken;
};
type WorldSlice = {
  schema: "kizuki.world-slice/v1";
  task: string;
  budgetTokens: number;
  tokens: number;
  tokenizer: string;
  constraints: readonly SliceItem[]; // mandatory, with every qualification needed to read them
  detail: readonly SliceItem[]; // optional
  providers: readonly ProviderCoverage[];
  complete: boolean;
  truncated: boolean;
  coverage: Coverage;
};
```

**Rules:**

- Each provider classifies each item as mandatory (a constraint and every qualification it needs: perspective, valid time, conflict) or optional detail. Mandatory items are selected first in a fixed order (kind order, then stable ref), then optional detail while it fits. The exact serialized response fits `budgetTokens` under the registered `tokenizer`.
- Mandatory context that cannot fit returns `incomplete` with the gap `required_context_overflow`. It never returns a smaller result marked complete.
- A requested kind whose provider is not registered appears in `providers` as `unavailable` with reason `not_landed`, or `extraction_off` when the kind is registered but dark. `complete` is false whenever any requested provider is unavailable. Nothing is omitted as complete.
- A complete slice issues a view token, so a re-read with `priorView` reports `unchanged` when nothing visible changed. Hidden evidence changes no constraint, ordering, count or omission notice. `truncated` is a boolean and never a count.
- When extraction has never run for a visible source the slice is `incomplete` with the gap `pending_consolidation`, not an empty complete slice.
- The session-start context sections are rendered from the same compiler.

**Delivered by:** the slice workstream, operation `slice`.

**Oracle fixtures:** `world-slice-budget`, `world-slice-partial`

**Gap use:** `required_context_overflow`, `coverage`, `pending_consolidation`, `traversal_limit`

**Fallback:** With no provider landed beyond the Concept and Situation providers, the slice lists every other requested kind as `unavailable` and is `complete: false`.

### WorldDiff

A World Diff compares a retained baseline view with a fresh authorized view for the same principal, query and namespace. It adds no table: the baseline projection lives in the view token row.

```ts
type WorldDiff = {
  schema: "kizuki.world-diff/v1";
  added: readonly ClaimRef[];
  removed: readonly ClaimRef[];
  changed: readonly {
    claim: ClaimRef;
    fields: readonly (
      "perspective" | "valid" | "context" | "assessments" | "conflict"
    )[];
  }[];
  truncated: boolean;
};
type DiffInput = { operation: "diff"; of: object; priorView: ViewToken }; // `of` is one object operation input
```

**Rules:**

- Each of `added`, `removed` and `changed` holds at most 128 entries. A correction that supersedes a claim shows the old claim in `removed` and the new claim in `added`. `changed` lists claims that stay live while a qualifier changed.
- The result states follow the view matrix. An unchanged projection returns `unchanged`. A changed one returns `current` with the diff and a fresh token when capacity permits. A baseline that is unknown, expired, evicted, erased, from another principal or namespace, from before a restore, or from before a narrowed grant returns `new_view_required` with no old identifier, count or explanation.
- A diff of an incomplete fresh result is `incomplete`, not a diff. Truncation beyond the bound is `incomplete` with the gap `traversal_limit`. Missing history returns `new_view_required` or `unavailable` with reason `history`, and never means no change.
- Hidden-source activity leaves the diff bytes unchanged. The diff respects the 256 KiB bound and works for every registered kind through a default relation-level comparison.

**Delivered by:** the diff workstream, operation `diff`, after the view-token work.

**Oracle fixtures:** `world-longitudinal-design`, `world-snapshot-control-binding`, `world-view-noninterference`

**Gap use:** `coverage`, `traversal_limit`

**Fallback:** A principal with no view partition gets `new_view_required` for a `priorView` and complete current reads without a diff.

### Atlas

Atlas views compose operations that exist into human views. A panel whose provider has not landed says so. It is never shown as empty.

```ts
type AtlasPanelId =
  | "home"
  | "resume"
  | "changed"
  | "people"
  | "questions"
  | "commitments"
  | "stale"
  | "corrections"
  | "forecast";
type AtlasPanelState = {
  panel: AtlasPanelId;
  status: "available" | "empty" | "partial" | "unavailable";
  reason: null | "not_landed" | "not_enabled" | "extraction_off";
};
type AtlasView = {
  schema: "kizuki.atlas-view/v1";
  panel: AtlasPanelId;
  panels: readonly AtlasPanelState[]; // the home view lists every panel
  content: object | null; // the operation result the panel renders
  coverage: Coverage;
};
type AtlasInput = {
  operation: "atlas";
  panel: AtlasPanelId;
  priorView?: ViewToken;
};
```

**Rules:**

- Each panel renders the result of an existing operation: `resume` a slice or resume result, `changed` a World Diff plus corrections with the impact returned by the correction operation, `people` person cards, `questions` the frontier, `commitments` the commitment entries of Situation v2, `stale` items with the gaps `stale_dependencies` or `pending_consolidation`, `corrections` receipted corrections with their impact, and `forecast` the forecast scores.
- A panel whose provider has not landed is `unavailable` with reason `not_landed`. Before forecasts are enabled the `forecast` panel is `unavailable` with reason `not_enabled`. The home view never presents a missing provider as `empty`.
- Every panel passes the noninterference harness, clips to the reader's grant and shows no restricted count. The human, developer and agent projections of one panel carry the same meaning: definition, attribution not stated as fact, evidence one step away, uncertainty and freshness.

**Delivered by:** the atlas workstream, operation `atlas` and the World tab of the local app.

**Oracle fixtures:** `world-atlas-projection`

**Gap use:** `coverage`, `pending_consolidation`, `stale_dependencies`, `traversal_limit`

**Fallback:** Each unavailable panel names its reason. A vault with no kinds beyond Concept and Situation still returns a home view that lists the other panels as unavailable.

### ResumeHandle

A resume handle lets a second authorized client pick up the first client's read. It carries no authority and no data. It is the single portable token in this design; it is not a principal-namespace ref.

```ts
type ShareInput = { operation: "share"; of: object }; // one concept, situation or other object read
type ShareData = {
  schema: "kizuki.resume-handle/v1";
  handle: string;
  expiresAt: string;
};
type ResumeInput = { operation: "resume"; handle: string }; // 43 unpadded base64url characters
// The result of `resume` is the ViewResult of the shared read, built for the redeemer.
```

**Rules:**

- A handle is 32 random bytes; only its SHA-256 is stored. It lives 24 hours and at most 16 are active per issuer, with oldest-issued eviction and the digest as the tie-break. The record binds the normalized read, the internal semantic handle, the valid window, a recorded-time cutoff and a digest of the issuer's scope at issue time. It stores no data and no text. Handles are cache class: never exported and empty after restore.
- Any authenticated principal holding the `world_view` grant may redeem a handle, under its own grant and namespace. The result contains only refs in the redeemer's namespace and only what the redeemer may read.
- The one grant-derived disclosure is a coverage gap `coverage`, added exactly when the redeemer's scope is narrower than the issuer's scope at issue time. There is no count, no label and no other trace of the issuer.
- Unknown, expired, restored and revoked-issuer handles, and a handle whose target the redeemer cannot read at all, all answer `new_view_required` with identical bytes. A redeemer without the `world_view` grant gets `denied` before any lookup, as for every operation.
- `share` requires that the issuer can read the target now. A target the issuer cannot read answers `not_found`.
- Before the known-at history work lands, `resume` is a current read and the recorded-time cutoff is kept only as the issuer's revision marker and is never disclosed. Whether a later slice may read at that cutoff is a follow-on decision.

**Delivered by:** the view-token workstream, operations `share` and `resume`.

**Oracle fixtures:** `world-longitudinal-design`, `world-snapshot-control-binding`, `situation-error-parity`

**Gap use:** `coverage`

**Fallback:** For a principal with no capacity, `share` answers `unavailable` with reason `storage` and current reads are unaffected. Every failure to redeem answers the same fixed `new_view_required`.

## Attention and forecasts

### Attention

Attention proposes goal-aware cues over permitted projections. Dispositions change only attention state. They never change a claim's confidence or authority and never gate canon.

```ts
type CueKey = string; // 43 base64url characters: SHA-256 of the principal namespace,
// provider id, visible subject ref and visible basis digest
type AttentionState =
  | {
      state: "candidate";
      cue: CueKey;
      source: "blocker" | "uncertainty" | "commitment_due" | "stale_summary";
      subject: ObjectRef;
      disposition: "none" | "dismissed" | "snoozed";
      snoozedUntil: string | null;
    }
  | { state: "quiet"; reason: "no_material_change" }
  | { state: "missing_coverage"; reason: "source_unobserved" }
  | { state: "stale_consolidation"; reason: "summary_older_than_ledger" }
  | {
      state: "provider_failure";
      reason: "model_unavailable" | "provider_error";
    };
type Attention = {
  schema: "kizuki.attention/v1";
  states: readonly AttentionState[];
  coverage: Coverage;
};
```

**Rules:**

- Volume is not urgency. There is no mention-count input. Forty-eight mentions with no material change yield `quiet` with reason `no_material_change` and no interrupt.
- `missing_coverage`, `stale_consolidation`, `provider_failure` and `quiet` are four distinct states, and none is folded into another. Missing coverage is never reported as quiet.
- A `CueKey` is derived only from values the principal can already see, so it discloses nothing hidden and needs no new wire kind. Delivering the same key twice reports `duplicate: true` from the file notifier and writes one brief line.
- Dismiss and snooze are written only by the owner command and by delivery. Agents read candidates and write no attention state. No MCP write tool is added. Attention state is bookkeeping class: exported, restored and erased on purge.
- A scoped principal sees only candidates from its own permitted projections and never another principal's dispositions. Hidden changes never create, remove or reorder a candidate.
- The delivery channel is the file notifier only by default. An outward channel needs an explicit owner yes.

**Delivered by:** the attention workstream: providers, the notifier idempotency, the owner command and the read-only `attention` operation.

**Oracle fixtures:** `world-cue-quiet`, `world-cue-coverage`, `world-cue-dismissal`, `cue-d10-reconciliation`

**Gap use:** `coverage`, `pending_consolidation`, `stale_dependencies`

**Fallback:** Stale consolidation and provider failure are reported as their own states and are never delivered as an interrupt. With no model the read still works and reports the consolidation states.

### Forecast

A forecast is a frozen, scored, deterministic-baseline prediction about a commitment. It is kept apart from current fact. This contract exists only if the owner accepts the forecast schema; without that decision no operation and no table exists.

```ts
type ForecastQuestion =
  "commitment_met_by_due" | "next_independent_inspection_meets_criterion";
type ForecastRecord = {
  subject: ObjectRef; // the Commitment node
  question: ForecastQuestion;
  method: "deterministic_dependency";
  class: "prediction" | "analysis"; // counterfactual and hypothesis records are analysis
  frozenAt: string; // RFC 3339 recorded-time cutoff
  inputs: readonly ClaimRef[]; // only claims recorded at or before frozenAt
  probability: number; // in [0, 1], from a fixed rule, never fitted to this vault
  status: "unresolved" | "resolved_met" | "resolved_not_met" | "censored";
  resolvedBy: readonly ClaimRef[];
};
type Forecast = {
  schema: "kizuki.forecast/v1";
  records: readonly ForecastRecord[];
  coverage: Coverage;
};
type ForecastScores = {
  schema: "kizuki.forecast-scores/v1";
  method: "deterministic_dependency";
  resolved: number;
  unresolved: number;
  censored: number;
  brier: number | { status: "unavailable"; reason: "insufficient_history" };
  certainWrong: number;
  cost: {
    predictions: number;
    retries: number;
    maintenance: number;
    unknown: readonly { metric: string; reason: string }[];
  };
  usefulness:
    | { status: "unavailable"; reason: "insufficient_history" }
    | { status: "observed"; actIfAtLeast: number; netValue: number };
  coverage: Coverage;
};
```

**Rules:**

- A record is addressed by its subject, method and `frozenAt`; it has no wire ref of its own. It is an append-only journal entry: never canon, never a belief store and never a contributor to a claim's confidence.
- The inputs exclude everything recorded after `frozenAt`, and later evidence never rewrites the earlier prediction. The deterministic baseline is computed and stored before any model-based candidate, and this slice makes no model call.
- Resolution comes only from an independent observation or an explicit owner statement. An absent observation leaves the record `unresolved`, never success.
- Scores report the Brier score, unresolved and censored counts, cost and usefulness separately. Below the minimum resolved count the score is `unavailable` with reason `insufficient_history`, not zero, and the operation-level result is `unavailable` with reason `history`.
- Counterfactual and hypothesis records are `analysis` and never appear in current-world reads. Two plausible hypotheses may coexist, and a correlation is never labelled a cause.
- The journal is authority class: exported, and correction, revocation and purge delete or invalidate the records and their caches.

**Delivered by:** the forecast workstream, operations `forecast` and `forecast_scores`, behind the owner decision.

**Oracle fixtures:** `world-forecast-baseline`, `world-forecast-prefix`, `world-forecast-scoring`, `world-forecast-counterfactual`, `world-forecast-hypothesis`, `world-forecast-purge`

**Gap use:** none

**Fallback:** Before the owner accepts the schema there is no operation and no table, and the Atlas forecast panel is `unavailable` with reason `not_enabled`. With too little history the scores are unavailable with reason `insufficient_history`. No probability is invented and a learned-model forecast is never advertised.

## Fixture oracle map

| Contract                | Oracle fixtures                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Question                | `world-question-copy`, `world-question-reopen`                                                                                                                                                                                             |
| Person                  | `world-perspective-binding`, `rich-subject-quoted-disagreement`, `rich-subject-homonym`                                                                                                                                                    |
| Skill                   | `world-outcome-mastery`, `world-procedure-evidence`                                                                                                                                                                                        |
| Framework               | `rich-subject-nested-frameworks`                                                                                                                                                                                                           |
| Procedure               | `world-procedure-evidence`, `world-outcome-usefulness`, `world-outcome-mastery`                                                                                                                                                            |
| Commitment and Decision | `world-commitment-binding`, `world-longitudinal-design`                                                                                                                                                                                    |
| Situation v2            | `world-commitment-binding`, `world-longitudinal-design`                                                                                                                                                                                    |
| ArtifactVersion         | `world-artifact-binding`, `world-artifact-content-binding`, `world-artifact-text-region`                                                                                                                                                   |
| Outcome                 | `world-outcome-stages`, `world-outcome-evidence`, `world-outcome-replay`, `world-outcome-copy`, `world-outcome-confounded`, `world-outcome-usefulness`, `world-outcome-matched-evaluation`, `world-outcome-mastery`, `world-outcome-purge` |
| WorldSlice              | `world-slice-budget`, `world-slice-partial`                                                                                                                                                                                                |
| WorldDiff               | `world-longitudinal-design`, `world-snapshot-control-binding`, `world-view-noninterference`                                                                                                                                                |
| Atlas                   | `world-atlas-projection`                                                                                                                                                                                                                   |
| ResumeHandle            | `world-longitudinal-design`, `world-snapshot-control-binding`, `situation-error-parity`                                                                                                                                                    |
| Attention               | `world-cue-quiet`, `world-cue-coverage`, `world-cue-dismissal`, `cue-d10-reconciliation`                                                                                                                                                   |
| Forecast                | `world-forecast-baseline`, `world-forecast-prefix`, `world-forecast-scoring`, `world-forecast-counterfactual`, `world-forecast-hypothesis`, `world-forecast-purge`                                                                         |

These fixtures validate their own design flags today and never call product code. A fixture counts as executable only when a test that calls a public seam is bound to its id. Until then the honest measure of progress is the coverage table, not "closed on design fixtures".

## What this appendix does not define

- Typed refs for scoped chunks and typed write arguments. RFC 0004 defines them and they are a separate owner decision.
- Any model-based forecast method, any consolidation prompt, and the extraction prompt for a kind.
- Any artifact byte custody, inspection or rendering. Kizuki hosts no agent loop and executes nothing.
- Identity authority for people. Concept identity is in [Amendment 11 of RFC 0004](0004-living-epistemic-world-model.md#amendment-11-identity-subset).
- Storage: table classes, migrations and their numbering are in [Appendix A](0004-world-storage.md#shipped-subset-and-migration-allocation-for-the-world-model-expansion).
