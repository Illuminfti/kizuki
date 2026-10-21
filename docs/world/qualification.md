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

Calls are sequential with at least 60 seconds between starts and at most 100
selected cases. The configured bridge must also enforce cross-process daily
limits and one in-flight call; the runner does not replace those controls.
Each case receives one attempt with adapter retries disabled. A refusal is
retained, never silently retried or replaced. Do not tune a prompt against this
split or select favorable responses. Any subsequent tuning requires a fresh
unseen corpus and keeps the previous result.

The new output file is created exclusively with mode 0600. A pending trace is
fsynced before each request and the result after completion. A killed run
therefore retains pending work as unproven; restarting uses a new output file,
not a claimed resume. The report pins the source commit/clean state, runner,
registry, corpus and complete system prompt, plus request/response hashes,
per-case conditional prompt hashes, timing, parsed responses and measured usage. An untracked evaluator
cannot claim a clean source revision. `--cases` supports diagnosis, but a
partial kind never qualifies.

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
