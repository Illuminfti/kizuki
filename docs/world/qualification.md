# World extraction qualification

The V6 runner evaluates typed model extraction against a frozen, authored
synthetic corpus. It uses the actual LLM adapter and ProducerV2 parser. The
candidate registry enables existing modules only in the evaluator; it never
changes production flags, source consent, the ledger or a vault.

## Scope and expected results

The corpus contains positive, abstention, perspective and time cases for
Concept, Situation, Question, Person, Skill, Framework, Procedure, Commitment
and Decision. Additional cases exercise every newly proposed predicate,
conflicting speakers, supplied-handle separation and source-only identity
refusal. Expected tuples are fixed before model calls and are never sent to the
model. Every required tuple must appear, no unsupported tuple may appear, and
there must be no dropped output or unknown usage. An empty answer passes only
an applicable abstention case.

Five Concept cases exercise the actual conditional identity-grounding prompt:
compatible prior concepts, an earlier retained label, ambiguous homonyms,
unavailable proof, and copied/quoted labels. Witness mentions must nominate
exactly the predeclared request-local handles, and grounding-context records
cannot count as witness citations. Retiring a label does not itself revoke a
retained valid proof. Missing/purged host proof and final identity admission
remain independently tested by the public identity and consolidation suites;
model output does not establish host authorization.

The scorer preserves subject references, object kinds, holder, speaker,
addressee, mode, interpretation, context, polarity, validity and record-level
citations. It permits only declared alternatives and whitespace/Unicode/date
normalization. Free-text rendering is retained in receipts but is not graded.
The typed parser checks source-span bounds; semantic scoring requires the
correct source record, rather than one exact wording span. This is extraction
quality evidence. Durable filing, namespace isolation, current authority,
correction, revocation and actual consumer behavior retain their separate
public-seam gates.

Existing Concept/Situation and learning predicates have an explicit
`preexisting_unqualified` compatibility baseline pinned to their original
metadata. This keeps the offline gate usable without claiming an earlier
held-out run. New or changed offered kinds and predicates fail closed until an
exact reviewed qualification covers them.

## Run a frozen candidate

First commit the evaluator and its actual vocabulary modules. Confirm the
source is clean, preserve the corpus before any run, and use an owner-only
output directory. Missing modules, predicates, corpus or model configuration
produce `not_run`; they do not qualify an absent capability. For a checkout
containing all candidate modules, the complete invocation is:

```bash
bun scripts/world-qualification/run.ts \
  --kinds concept,situation,question,person,skill,framework,procedure,commitment,decision \
  --extensions situation.has_commitment \
  --base-url http://127.0.0.1:8787/v1 \
  --model YOUR_CONFIGURED_MODEL \
  --token-file /absolute/private/token \
  --out /absolute/private/new-qualification.json
```

The token file must be owned by the current user, inaccessible to group/other,
regular and not a symlink. It is read privately and used only in request
headers. The runner records neither its value nor its path. Remote endpoints
require the explicit `--allow-remote` option and existing authorization.

Calls are sequential with at least 61 seconds after the previous HTTP response
completes and at most 100 selected cases. This exceeds the bridge admission gap
even when HTTP admission was delayed. The configured bridge must also enforce cross-process daily
limits and one in-flight call; the runner does not replace those controls.
Each case receives one attempt with adapter retries disabled. A refusal is
retained, never silently retried or replaced. Do not tune a prompt against this
split or select favorable responses. Any subsequent tuning requires a fresh
unseen corpus and keeps the previous result.

The new output file is created exclusively with mode 0600. A pending trace is
fsynced before each request and the result after completion. A killed run
therefore retains pending work as unproven; restarting uses a new output file,
not a claimed resume. The narrowly reviewed v1-to-v2 continuation accepts only
exact pinned predecessor bytes, retains every successful transport including
semantic failures, and permits only an explicitly classified HTTP429/unrun
continuation. A changed corpus, prompt, model or registry cannot reuse it. The report pins the source commit/clean state, runner,
registry, corpus and complete system prompt, plus request/response hashes,
per-case conditional prompt hashes, timing, parsed responses and measured usage. An untracked evaluator
cannot claim a clean source revision. `--cases` supports diagnosis, but a
partial kind never qualifies.

For diagnosis of this fixed synthetic corpus, optionally add
`--raw-responses /absolute/private/new-responses.jsonl`. This separate file
retains successful HTTP response bodies before the producer parser, including
output the parser rejects. Each record carries the matching case, prompt,
request and response hashes from the normal receipt. The runner creates the
file exclusively with mode 0600, refuses an existing file or symlink, fsyncs
each record, and limits records to 2 MiB and the file to 32 MiB. Provider error
bodies and exact credential echoes are omitted with an explicit reason. Keep
this artifact private; it is diagnostic output, never model input or a
replacement for the scorer. No raw response file is created by default.

## Review and activation gate

Transport observation alone cannot prove provider identity: a local test
server can return a response. Review must independently establish the actual
configured service/provider, then pin both the exact report hash and the
provider-evidence artifact hash in `REVIEWED_QUALIFICATIONS` in `approvals.ts`.
This reviewed catalog is excluded from the evaluator fingerprint, so adding a
review pin cannot invalidate the very run being approved. Verifier, scorer,
corpus and producer code remain fingerprinted. Never register a
scripted scorer or fake-endpoint control as a qualification. There are no
reviewed report entries initially.

`verify:world` recomputes scores, exact inputs, hashes, complete case coverage,
measured usage and transport pacing before accepting a reviewed receipt. It
requires the same offered registry and runner fingerprint. New predicates must
have observed required positive tuples. Manually constructed in-memory status
objects cannot bypass this verifier. Changing production flags remains a
separate reviewed source change; the runner performs no activation.

## Verification

```bash
bun test scripts/world-qualification/score.test.ts scripts/world-verify.test.ts
bun scripts/world-verify.ts --registry-only
bun run typecheck
```

Scorer tests deliberately use scripted controls and a fake local endpoint to
prove rejection and provenance handling. They establish harness correctness,
not real model quality or production readiness.

## Fresh contract split

`corpus-v1.ts` preserves the original authored corpus. Its original receipts and
strict scores remain historical evidence. The current `corpus-v2.ts` contains
53 newly authored cases and uses the versioned v2 corpus schema. It includes
all four families for nine kinds, twelve domain cases and five conditional
grounding cases. No production kind is enabled by this change.

RFC0003 permits ordinary supplied and occurrence references. The new scorer
accepts only finite, predeclared, record-grounded representations of an entity;
it rejects a response that puts classification and details on different
representations. It never merges arbitrary names, records or source namespaces.
Ordinary parser-valid nominations are bounded data, while identity witness
nominations retain their exact host-proof oracle. Person subjects and Person
relationship endpoints retain the separate supplied-only admission rule.

Literal alternatives are declared in the corpus before calls; prose-specific
capitalization and final-period alternatives do not create a general fuzzy
matcher. The scorer still rejects invented objects, altered polarity,
incorrect speakers, omitted consumer prerequisites, and fabricated time. The
fresh negative Framework assertion must remain negative, and the Person time
case must retain both supplied endpoints and its exact relationship interval.

The repaired extraction prompt describes the registered kind and predicate
constraints from build-owned definitions, intersected with the request's
provided registry. It keeps the existing wire contract and includes no source
text in the system message. Synthetic model-adapter → writer → consumer tests
prove the boundary for structured Person, refused raw-name Person, and a
nominated Question occurrence. Those tests are separate from real model quality.
