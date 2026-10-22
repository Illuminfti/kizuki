# Person qualification split v4

This is preparation for a future qualification candidate, not an activation or a
model-quality result. The seven newly authored synthetic Person cases in
`corpus-v4-person.json` have no provider observations. `corpus-v4.ts` replaces
only the Person group and retains the other 55 v3 cases unchanged. The composed
corpus has 62 cases. It is **not a wholly unseen split**: the retained Concept
cases have already been observed. Prior v3 bytes, reports and approval pins remain
unchanged.

## Contract and earlier evidence

The earlier combined Concept/Person run recorded Concept ten passes and Person
**five passes and two failures**. Its immutable report SHA-256 is
`522432d1a532bd1e75e8d03589748f348a759347826d6566272e9fbfe11eb039`.
Both Person failures passed structural parsing with zero dropped drafts:

- The disputed-role case correctly preserved opposite quoted roles, but made
  the source's directly stated Person classification and label `reported`.
  The current card reader requires positive `asserted` classification. The new
  prompt sentence separates source classification from the witnesses' roles;
  it does not promote either into owner authority.
- The single-view case supplied all required meanings plus `learning.exposure`.
  The v3 oracle allowed no extra tuple, so that run remains failed. A witnessed
  view supports exposure, while consumption does not establish understanding or
  mastery ([RFC 0004](../../rfcs/0004-living-epistemic-world-model.md), learning
  facets and learning evidence). Only the new reading case permits this exact
  additional Person-to-Concept tuple with the same source, null time and explicit
  asserted exposure. Interest remains uncertain and inferred. Explanation,
  application, demonstration, professional role and invented time remain failures.

The other new instances cover positive and explicitly negated roles, two
conflicting unstructured witnesses, an instruction without identity, independent
structured homonyms, source-only quoted Concept attribution, and a relationship
with an exclusive validity end. The optional quoted Concept tuples in the
source-only case preserve their exact speaker and quoted mode; they do not
permit a Person card for a name in a transcript.

`corpus-v4-freeze.json` pins the seven cases, the complete composed corpus, the
unchanged v3 file, the authoring registry and prompt. This authoring freeze is not
execution approval. Any substantive change after provider observation requires
a new split; the failed old examples are diagnostic evidence, not new test data.

## Current prompt preparation

The original `corpus-v4-freeze.json` remains the unchanged authoring record from
commit `274f311036072926114cc346781bce3127388077`. Its prompt hashes describe that
historical source, not the later reviewed perspective paragraph. The separate
`corpus-v4-execution-pins.json` records the current prompt, the same registry and
all 62 unchanged cases. It is preparation only: it does not authorize execution,
provide a model-quality result or replace a qualification receipt.

The complete nine-kind registry now composes two system prompts:

- Ordinary requests (56): `dd8bf337b277ba61c72f2bddfcfcc8aa7bb4a24b9a9efae16aa231d478c8e4db`.
- Conditional identity-grounding requests (6): `48febdf722d0c6f579c1f7a6051b443369207f55acfb7ad3e96bef4e93fcef76`.

These differ from the production Concept/Situation registry prompts. No bridge
admission, approval, product offered flag or production registry changes here.
Before actual qualification, pin the final clean source and runner again, review
exact prompt admission and usage, and retain the observed/unseen distinction
above. Concept/Situation remains the only activation scope until the wider kinds
have the required actual qualification and lifecycle evidence.

## One final registry, complete receipts

Do not successively enable kinds and repeat earlier qualification at each new
registry. Prepare one clean, undeployed candidate with the complete intended
registry, inspect every input and prompt, and freeze it before calls. The
existing registry builder gives this dependency closure:

| Kind | Cases | Origin |
| --- | ---: | --- |
| Concept | 10 | Retained v3; known cases |
| Situation | 6 | Retained v3 |
| Question | 6 | Retained v3 |
| Person | 7 | New v4 |
| Skill | 6 | Retained v3 |
| Framework | 6 | Retained v3 |
| Procedure | 7 | Retained v3 |
| Commitment | 8 | Retained v3 |
| Decision | 6 | Retained v3 |
| Total | 62 | Seven new, 55 retained |

The registry includes `situation.has_commitment` and its companion extension
predicates. Its authoring digest is
`9aec3c141363eaad29042928d41102522ab4f7a86363f7d03a47dd8461052803`.
Person must be present for the structured Commitment parties; every required
and optional tuple must be offered before execution. The offline test preflights
all 62 inputs and checks required coverage of the newly offered predicates.

The simplest existing-runner route is one complete run, after separate exact
source/endpoint/prompt-admission/usage review. This command is a future example,
not an instruction to run now; endpoint, file credential and private output
variables must be supplied through the established operator path:

```bash
bun scripts/world-qualification/run.ts \
  --kinds concept,situation,question,person,skill,framework,procedure,commitment,decision \
  --extensions situation.has_commitment \
  --base-url "$QUALIFICATION_BASE_URL" --model "$QUALIFICATION_MODEL" \
  --token-file "$QUALIFICATION_TOKEN_FILE" \
  --out "$PRIVATE_QUALIFICATION_DIR/observed.json" \
  --raw-responses "$PRIVATE_QUALIFICATION_DIR/raw.jsonl"
```

For staged complete-kind runs, the future isolated evaluator's candidate modules
must already offer that same complete closure before the first request. Then
`--kinds person`, for example, selects seven cases without changing the effective
registry. Confirm each stage's `registry_sha256` is identical. This preparation
does not change that evaluator composition or any production offered flag.
Running the present default candidate with different `--kinds` values does
change its registry and cannot produce interchangeable approvals. Using `--cases`
to omit required cases does not qualify their selected kind.

Keep one attempt per case, the existing response-based spacing and all adapter,
bridge, quota and token limits. A refusal halts the run. There is no automatic
retry or approval for 62 calls here. Freeze the complete plan once; review each
complete group's actual outputs before any additional stage. Synthetic oracle
controls are not provider receipts. Production enablement additionally requires
durable admission, public consumer and correction/revocation/purge evidence.

## Approval binding and pending gate

The current Concept-only approval in `approvals.ts` remains historical evidence
for its measured source, prompt, corpus and registry. The new prompt and corpus
change the runner fingerprint, so that approval **must not pass the current
qualification gate on this branch**. The full gate remains pending replacement
receipts; this preparation must remain unmerged meanwhile. No catalog entry is
removed and no baseline exemption or verifier bypass is added.

Receipt validation binds the measured clean 40-character Git source identity,
current runner digest, complete corpus, offered registry, exact prompts/inputs,
measured transport, pacing, usage and strict semantic scores. It does not demand
that the measured Git SHA equal a later receipts-only commit. Approval pins and
report files are excluded from `runnerDigest`, so final reviewed receipts can be
registered in one later commit without a circular need to rerun them. A prompt,
corpus, producer, registry or runner change requires matching new measurements.
Replace the active Concept approval only once the complete intended candidate
has the required reviewed receipts, preserving the old report and its pins in
history. Neither old Concept success nor the baseline group counts qualify this
new candidate.

## Verification

```bash
bun test scripts/world-qualification/corpus-v4.test.ts \
  packages/core/test/producer/prompt-v2-catalog.test.ts
bun run typecheck
```

The tests validate every fresh required alternative and optional tuple against
the unchanged parser and scorer, retain all non-Person cases, prove input budgets
at the final registry, and reject authority, identity, interest, mastery and time
promotion. These are offline contract checks; no model, bridge or live vault is
contacted.
