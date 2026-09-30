# Fresh-agent evaluation

The implemented benchmark measures how much of a synthetic owner's world a
fresh authorized client can retrieve through Kizuki's existing surfaces. It
does not run an answering agent or claim that the client understands the world.
The questions follow [the README's fresh-agent questions](../README.md#what-a-fresh-agent-should-be-able-to-understand).

Run from a checkout with its pinned Bun and installed workspace dependencies:

```sh
bun scripts/eval/fresh-agent/run.ts --out "$TMPDIR/fresh-agent-result" --size full
```

Use a private temporary directory with safe, owner-controlled ancestors. The
destination must not exist. It receives a synthetic `vault/`, generated
import `inputs/`, `questions.json`, `report.json` and `report.md`. No existing
vault is read. The runner refuses an existing destination instead of replacing
it. Exit status is 1 on a detected leak or unavailable surface, 2 on invalid
arguments, and 0 for a completed measurement without either failure. Low recall
and historical exposure remain reported measurements, not hidden failures.
The output directory is an experiment artifact; do not commit its generated vault.

## Scenario and public seams

`scripts/eval/fresh-agent/persona.ts` defines stable logical fact IDs, source
records, values, validity windows, access expectations and gold IDs for each
question. The small persona includes Ada, Grace, the Orchard bridge project,
a decision, commitment, priority, skill, a learning example and a concept. A
collaboration claim proposed by a fixture agent is scored against its own gold
fact ID. The persona also includes an expired blocker, a mistaken blocker
corrected by the owner,
two incompatible survey statements, an explicitly uncertain flood estimate,
and three privacy probes. The full persona adds six background facts to put
more pressure on selection. Source text does not contain oracle fact IDs.

Generation initializes a sealed vault through the CLI's `init` command with
`--no-default --no-service`, then imports JSONL through the existing
`LegacyEventsConnector` and Core `runBackfill`, repeats the imports to check
idempotence, and runs the real v2
model producer over a scripted in-process `LlmPort`. The real parser, grounding
checks, source policy, filing and receipted writer all run. The script invokes
`propose` as a narrowly granted fixture agent and `correct` as the owner through
Core serving, and rebuilds the lexical floor through `rebuildRetrieval`.
It never inserts claim rows or writes canon directly.
The model endpoint named by the synthetic consent policy uses a reserved test
domain; the fake LLM has no network transport and needs no credential.

The records and oracle are deterministic. Operational metadata minted by the
public seams (IDs, timestamps, hashes and opaque handles) is deliberately left
to Core. Thus fresh vaults are semantically reproducible, not byte-identical.
The surface clocks, native correction time, tie-breaking IDs and tokenization
of those IDs can change individual packed results and token counts. Reports
retain the actual observations so every score can be recomputed without a model.

## Principals and surfaces

The owner uses the unchanged owner grant. A newly enrolled agent receives an
explicit `personal` ceiling, four subject IDs, and only `search`,
`context_packet` and `world_view`. The inert arbitrary-agent default is not
changed. Its transient token stays in memory, with only its hash in the vault;
the runner does not write an agent credential file or put the token in a report.

The decoys exercise three separate denials: an out-of-scope family project,
a private medical-reserve fact about an in-scope project, and a source with no
recall consent. The last is withheld from the owner too. Corrections use Core's
native sensitivity handling; gold access expectations include that handling.
The legacy proposal inherits the strictest default across this importer's
sources, which is private here, so its relationship is also owner-only. These
labels are resolved by Core; the fixture never relabels a claim to widen access.

Each question has a fixed lexical task hint and a fixed world lookup plan:

| Surface | Measured output |
| --- | --- |
| Session hook | Real `runSessionStart`, direct mode, generic harness, with a synthetic project-directory hint; the returned Markdown is scored |
| `context_packet` | Core recall-purpose packet using the lexical hint; facts/citations are scored from its Markdown, while the complete envelope is counted for tokens and scanned for leaks |
| `search` | Core `scope=all`, limit 20, using the same hint; the whole envelope is counted for tokens and scanned for leaks |
| `world_view` | Core discovery followed by cards returned on that discovery page, with the question's Concept or Situation label; discovery and cards are both counted |

Packet Markdown has a 2,000-token budget; the structured envelope adds overhead
to the reported token count. World reads use all valid windows and current
recorded knowledge; the gold distinguishes expired and corrected facts.
Discovery and all returned cards count
as one multi-call observation. These are different retrieval workflows, not
equal-cost competing agents. Some questions ask about several domains while
the minimal world operation reads only one; misses are useful baseline evidence.

## Deterministic metrics

The scorer in `score.ts` uses case-insensitive, whitespace-normalized exact
value matching. It does not use embeddings, a model judge or a fuzzy threshold.
Counts are unique fact IDs within an observation. Every row includes the
question, principal, surface, missing/recalled/stale/leaked IDs, denominators,
status and these metrics:

| Metric | Definition |
| --- | --- |
| Fact recall | Returned authorized current gold facts divided by authorized current gold facts for that question |
| Stale-fact rate | Returned expired or owner-corrected fact values divided by all matched fact values, including incidental facts |
| Leak count | Unique forbidden fact values found anywhere in the complete output, including decoded JSON strings and metadata; must be zero for each row |
| Provenance rate | Matched fact values with a citation on their own atom divided by all matched fact values |
| Tokens used | Actual output tokens encoded with the packet's bundled `cl100k_base` tokenizer; includes envelope and discovery overhead when present |

Provenance means an addressable claim/page/event reference for Markdown, source
IDs for search chunks, or local admission evidence for a typed world relation.
A citation on an unrelated sibling cannot count. This measures reference
presence, not source truth or whether every source expansion succeeds.
Question rows with no authorized expected facts have `null` recall (`n/a` in
Markdown). Empty output has zero tokens and `null` stale/provenance rates;
unavailability is separately visible, as is incomplete world coverage.
Summaries are micro-averages of question
counts, so a fact relevant to several questions is counted once per question.
Leaks and tokens are summed across observations; privacy failures cannot be
averaged away by recall.

## CI proof and limits

The small-persona test is discovered by the existing repository test gate:

```sh
bun test scripts/eval/fresh-agent --timeout 120000
```

On a shared worker, run it through that worker's `ktest` semaphore. Tests check
all four surfaces and both principals, zero measured leaks, scorer arithmetic,
the privacy denominator, escaped JSON leaks, missing-surface handling and
citation locality. Each surface/principal pair must recall at least one gold
fact. The owner must retrieve the scope and ceiling decoys, proving those
denial probes contain real readable facts; the corrected blocker and proposed
relationship must also be retrievable under their expected access.

This is a retrieval baseline for a hand-authored synthetic persona and scripted
extraction, not an extraction-quality or real-agent reasoning benchmark. Exact
matching can miss paraphrases and partial leaks. Historical text is counted as
stale exposure even when clearly quoted as historical; this is not a claim that
the product asserted it as current. Access correctness is probed by known decoys,
not by exhaustive adversarial noninterference or purge tests. Session selection
also depends on its live seven-day window. No provider, latency, memory-use,
embedding, live-sync, downstream tokenizer, prompt-injection resistance or
human outcome claim is made. Those need separate measurements.

The branch's PR records the observed baseline with its exact head. Future
workstreams should compare the same persona, questions, grants, hints, budget
and scorer version, inspect missing IDs and privacy failures, and state any
changed retrieval or extraction configuration.
