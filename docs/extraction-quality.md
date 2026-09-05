# Extraction quality fixture

This fixture qualifies the extraction scorer and the native product path using
12 frozen synthetic cases. It does not measure a real model's extraction quality,
approve fine-tuning, or satisfy a release or calendar-soak gate. The reference
answers and scripted candidate responses live in separate files; the native
runner substitutes only ledger-generated event IDs in the candidate responses.

The corpus is `scripts/fixtures/extraction-quality-v1.json`. Its seven positive
cases contain 11 required tuples; five cases require successful abstention.

| Case | Evidence and required behavior |
| --- | --- |
| q01 | Direct evidence of Ada's Orchard library role |
| q02 | Positive and negative role claims with explicit half-open validity intervals |
| q03 | A dated claim and an undated claim about different people |
| q04 | Conflicting role evidence retained with its own citations |
| q05 | A greeting that supports no durable claim |
| q06 | An ambiguous initial that supports no named-person claim |
| q07 | Contact frequency that does not establish relationship quality |
| q08 | A missing metric that does not establish a zero value |
| q09 | A quoted instruction that must not become an extracted claim |
| q10 | First-person statements bound to each event's sender and recipient |
| q11 | A supported tool preference, also used by adversarial scorer tests |
| q12 | A supported project claim carried alongside benign provider metadata |

## Run the scorer

Use the repository's pinned Bun 1.3.10. From the checkout root:

```bash
bun scripts/evaluate-extraction.ts \
  --corpus scripts/fixtures/extraction-quality-v1.json \
  --responses scripts/fixtures/extraction-quality-scripted-v1.json \
  --out /tmp/extraction-quality-score.json
```

The output path must be new. Exit 0 means the scripted contract passed, exit 1
means the complete evaluation measured failures, and exit 2 means inputs or
execution were invalid. All inputs are size-bounded regular files. The response
set must match the canonical corpus digest and include exactly one result for
each case. Version 1 accepts only `scripted_contract`; a file cannot self-attest
that a real model produced its content.

Tuple matching is one-to-one over kind, subject, registered predicate, an
annotated object, polarity, exact validity interval and an approved citation
set. Unicode normalization and whitespace normalization are allowed; arbitrary
semantic similarity is not used. An unfamiliar body is explicitly unscored and
requires annotation. Extra and duplicate tuples are false positives. Citations
must support the particular tuple, not merely refer to any real record. The
private sensitivity floor is scored separately from tuple precision and recall.

Reports retain numerators and denominators, with `null` for an undefined rate.
Successful empty extraction, unavailable service, schema rejection, denial and
refusal remain separate outcomes. Dropped drafts cannot count as abstention.
Missing provider token usage remains unknown, including when the native receipt
defaults its token count to zero. No currency cost is inferred.

## Run the native consumer proof

```bash
bun scripts/extraction-quality-native.ts --out /tmp/extraction-quality-native.json
```

The runner creates and removes temporary synthetic vaults. A loopback-only
OpenAI-compatible endpoint supplies the separately frozen responses through the
real configured model port and scheduled extraction producer. It uses an
isolated child environment with no account credentials. Every request must
contain the exact expected system prompt, the expected fenced event text and
no additional evidence. Requests and responses are hashed, and each case is
limited to one request.

The runner uses the native legacy-events enrollment and import path. Import
must refuse before source consent and succeed after the exact source grant.
An unexpected import failure stops the run.

Source consent is provisioned through the public Core source-grant API. This
does not prove native policy-file custody: UID-mapped execution namespaces can
correctly fail the CLI's separate POSIX ownership checks. Imported text, subject
roles, source identities and timestamps are checked against the frozen corpus
before the model can consume them.

For each case the runner records actual filed claims and tests native CLI
ledger search, canon search, context citations and an absent query. Expected
claim bodies matching each case's query must appear with model authority in
canon results. Actual MCP
stdio sessions test owner recall and public-principal disclosure. Results are
compared before and after rebuilding derived state. The direct-evidence case
also exercises owner correction, exact-byte undo, export, restore into a clean
directory and model-free restored recall. Separate denied, unavailable and
malformed-response controls verify model call counts and that no claims file.

Raw and persisted extraction scores remain separate. RFC 0002 section 4.2 says
raw `valid_from: null` means the source's `observed_at`; the persisted reference
uses that observation time. Actual filed timestamps are never rewritten by the
scorer. Explicit validity dates are preserved, and a future case with multiple
different observation times needs an explicit reference annotation.

The native report binds the source SHA and tree, corpus, scorer, runner, prompt,
response set, command results, model calls and runtime event-ID mapping. A
product failure remains a failed report even when the test confirms that the
harness detected it correctly. Inspect `passed`, `persisted_score`, case
`failures` and `controls_passed`; a green harness test alone is not product
acceptance.

To use a release artifact from the same source SHA:

```bash
bun scripts/extraction-quality-native.ts \
  --artifact /absolute/path/to/release-artifact \
  --out /tmp/extraction-quality-native-artifact.json
```

The runner refuses symlink roots and validates the exact `BUILD.json` schema,
source SHA, supported native target and pinned Bun runtime. It verifies the
release checksum manifest, copies the artifact into its temporary fixture directory, verifies it again and
runs the copied `kizuki` and `kizuki-mcp` executables. A successful source run
does not stand in for this artifact consumer check.

## Verification

```bash
bun test scripts/evaluate-extraction.test.ts scripts/extraction-quality-native.test.ts
bun run typecheck
```

The scorer tests mutate candidate outputs to exercise invented object and body
content, omitted and duplicate claims, wrong subjects and citations, polarity,
validity, sensitivity, dropped drafts, missing usage and false provenance. The
native test verifies its own transport and recovery behavior while retaining
measured product failures in the report. Full repository verification remains
the separate `bun run verify` gate.

Before treating a later result as a real-model baseline, add a runner-owned
provenance contract, recorded bounded transport, explicit endpoint and spend
authorization, independent annotation of new paraphrases and a source-bound
receipt. Fine-tuning requires that accepted baseline and a separately reviewed
holdout evaluation; this synthetic fixture does not supply either.
