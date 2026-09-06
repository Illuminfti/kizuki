# Deep memory integration acceptance charter

Status: proposed test obligations, 6 September 2026. **These are not executable
tests, passing results or a release qualification.** Implement them through #496
and the owners in the [programme](retrieval-engine-integration.md). Reuse existing
proof when its exact scope matches; do not replace it with a new mock suite.

## Shared synthetic world and oracle

Use a disposable project named Meridian. Two different people share the display
name Jordan. Client A can read the project plus an unrelated restricted source;
client B can read only permitted project material. Neither is OWNER. Use current
public source-consent, identity/grant, capture, correction and serving APIs.

Reveal evidence in order: (T0) an owner-authored short constraint forbids a hosted
database; (T1) a conversation proposes, but does not approve, a hosted service;
(T2) an explicit local-storage decision and two independent commitments arrive;
(T3) a summary is generated; (T4) an owner correction supersedes a mistaken
deadline while consolidation is paused; (T5) an older in-flight job returns;
(T6) B's grant narrows; (T7) an enrolled source is revoked and purged; (T8) the
store restarts or restores into a clean target. Insert a role change valid before
its capture time and exact source versions supporting each transition.

Keep restricted fixtures, sealed expected answers and later evidence outside the
system under test until authorized and temporally available. Do not ingest the
oracle. Compare entire serialized responses and diagnostics, not only visible
prose. Test semantic assertions independently of the summarizer's own output.
Any synthetic fixture that needs a model distinguishes a stub from live inference.

## Lifecycle and volunteered context: #527

| ID | Given / action | Required observable result |
| --- | --- | --- |
| L01 | Cold client B resumes Meridian after A's work | Current permitted decision, decisive constraint and evidence arrive through Kizuki, not a copied A transcript. |
| L02 | A turn mentions ambiguous Jordan | No guessed identity card; return bounded ambiguity or no volunteered pointer without exposing denied candidates. |
| L03 | Repeat an unchanged entity across turns, then correct its claim | Unchanged delivery is suppressed; the authorized new revision becomes eligible again. |
| L04 | Compact the session after T4 | Rehydrate current constraint and correction; do not restore the obsolete deadline from a cached summary. |
| L05 | Selected context is dropped by the client before injection | Selection/serving counters do not claim injection, acknowledgement or actual use. |
| L06 | Hook unavailable, service offline or lifecycle unsupported | Capability and degraded/pull-only behavior are explicit; no raw-file or owner-mode fallback. |
| L07 | Retry a consented session-end capture containing injected memory | One observable capture effect; source lineage and machine origin prevent independent-support inflation. |

## Cards and cited synthesis: #484/#486/#488/#489/#495

| ID | Given / action | Required observable result |
| --- | --- | --- |
| C01 | Request a project/person card without a model | Useful deterministic permitted state with evidence/coverage; no fabricated model answer. |
| C02 | Resolve same-name people with different source-backed identities | Preserve distinct subjects and uncertainty; never merge on display name alone. |
| C03 | Render two commitments and repeated mentions of one | Preserve two distinct commitments; repeated evidence is not a third commitment. |
| C04 | Ask for a conclusion contradicted by a newly arrived source | Resolve through accepted semantics or qualify the conflict/freshness gap before claiming current understanding. |
| C05 | Ask whether a person replied when coverage is incomplete | State what connected evidence shows; do not infer universal absence. |
| C06 | Missing model, empty gather, malformed output and failed compose | Distinct documented outcomes; any extractive fallback is identified and cites only real permitted evidence. |
| C07 | Request the same card through human/Core/MCP surfaces | Equivalent state, evidence, uncertainty and permissions; read-only synthesis produces no canon mutation. |

## Scoped deltas and recovery: #490

| ID | Given / action | Required observable result |
| --- | --- | --- |
| D01 | More changes share a timestamp than fit in one page | Stable revision/keyset ordering drains the complete permitted set without livelock or omission. |
| D02 | Budget truncates page, claim and open-thread arms differently | Continuation covers every undelivered arm; advancing one arm cannot lose another. |
| D03 | Lose a response before acknowledgement, then retry | Safe redelivery or stateless replay; no premature durable cursor advance loses changes. |
| D04 | Insert a correction while pagination is in progress | Snapshot/high-watermark semantics ensure the correction is delivered now or on the next defined continuation. |
| D05 | Use wrong-principal/vault/scope or expired/pruned cursor | Safe denial or refresh-required, never unchanged; no foreign metadata in the error. |
| D06 | Change only a source inaccessible to B | B's content, counts, tokens and status reveal no inaccessible change within the stated threat model. |
| D07 | Narrow a grant, purge support, then resume retained state | Old managed views invalidate; no erased payload replay; independently retained external text is explicitly outside control. |

## Reranking and diagnostics: #528

| ID | Given / action | Required observable result |
| --- | --- | --- |
| R01 | Rerank an authorized shortlist containing low-lexical relevant evidence | Preserve IDs and the un-reranked tail; measure held-out quality rather than assuming improved accuracy. |
| R02 | Provider returns duplicate/out-of-range indices or nonfinite scores | Reject malformed scoring and use documented safe ordering; no invented score or dropped evidence. |
| R03 | Provider is absent, times out, returns empty/partial output or exceeds budget | Explicit distinguishable degradation; deterministic recall remains usable within resource bounds. |
| R04 | Local-only evidence meets a configured remote endpoint | Refuse that egress before sending query/document payload; configuration alone does not confer consent. |
| R05 | Correction, revocation or purge occurs during inference | Late output cannot disclose, cache or resurrect stale/denied evidence; revalidate before release. |
| R06 | Change model space/configuration or principal/scope with a cache present | Cache hit is refused or properly invalidated; no cross-policy or cross-model reuse. |
| R07 | Inspect stages with hidden high-ranking candidates present | Report actual effective stages without leaking hidden counts, query text, provider secrets or raw errors. |

## Freshness-safe maintenance: #503

| ID | Given / action | Required observable result |
| --- | --- | --- |
| M01 | New evidence arrives while an expensive phase is backlogged | Capture and invalidation proceed; reads are current or explicitly qualified, never falsely healthy. |
| M02 | Model unavailable versus genuinely empty successful batch | Only successfully covered input advances the checkpoint; unavailable is not empty. |
| M03 | Crash immediately before and after each durable effect/checkpoint boundary | Recovery is idempotent with documented receipts; no silent input loss or duplicate canon effect. |
| M04 | An older job finishes after T4 correction | Revision/effect fence rejects obsolete commit; correction remains highest authority. |
| M05 | Lease lost while a worker still executes | Stale holder cannot commit authoritative effects; heartbeat presence is not sufficient authority. |
| M06 | Burst updates plus older unprocessed input under fixed budgets | Coalescing remains bounded and older work is not starved; report backlog and resource use honestly. |
| M07 | Purge during queued/in-flight maintenance | Managed summaries, caches, queued payloads and retries cannot resurrect removed evidence; verify relevant stores. |

## Evaluation discipline: #496

| ID | Given / action | Required observable result |
| --- | --- | --- |
| E01 | Freeze current lexical/current-Kizuki baseline before the change | Exact corpus, code, config, evidence schedule and commands are recorded; no retroactive baseline tuning. |
| E02 | Evaluate a memory mechanism against an upstream comparator | Matched model/budget/hardware conditions or explicit separate unmatched results; no production dependency added. |
| E03 | Reveal a future correction or sealed answer key only after a query | The earlier answer uses neither; detect oracle leakage rather than accepting inflated scores. |
| E04 | Distill a session containing decisions, questions and distractors | Measure salient-unit retention, attribution and hallucination; no-output sessions remain in the denominator. |
| E05 | Measure context delivery, retrieval and end-to-end answers | Separate injection/use, all-evidence/any-hit recall and answer correctness; report uncertainty and sample limits. |
| E06 | Include warm/cold, ingestion, maintenance and retry runs | Report total cost, latency, memory and storage with disabled/unsupported/unrun arms explicit. |
| E07 | A quality win coincides with leakage, stale-as-current or data-loss failure | Hard gate fails; aggregate recall cannot compensate and no benchmark-win claim ships. |

## Setup, health and removal: #458/#527

| ID | Given / action | Required observable result |
| --- | --- | --- |
| S01 | Install client wiring beside existing servers and settings | Change only owned entries; preserve unrelated bytes and credential references. |
| S02 | Cancel/fail at each enrollment/configuration boundary | Partial authority stays inert; conditional rollback preserves prior working state or reports precise recovery. |
| S03 | Concurrent user edits config while rollback/uninstall runs | Detect conflict; never restore an entire obsolete file over the user's edit. |
| S04 | Repeat install, reconnect and uninstall | No duplicate identity/service, no rotated completed token, no orphan credential or unrelated deletion. |
| S05 | Configured hook never fired, dead rail PID exists, or model unbound | Health distinguishes configuration, reachability, exercise, qualification and degradation without leaking private metadata. |
| S06 | Run capture -> authorized read -> evidence resolution -> correction -> second read | Observe the actual current-source loop; recorded client/version/artifact and platform limits are explicit. |
| S07 | Test two independent real clients and an unfamiliar user | Separate their receipts from mocks/screenshots; record completion, interventions and re-explanation without invented timing. |

## Cross-cutting gate and evidence format

Every case preserves frozen ingress, current identity/grants, automatic sensitivity,
source purpose/egress policy, exact provenance, owner-correction precedence, one
receipted canon writer, model-free recall and physical-purge semantics. Resource
limits must include actual serialized metadata, not just excerpt text. When
mandatory context cannot fit, report insufficient/incomplete context rather than
quietly omitting a decisive constraint. Existing clients remain compatible unless
a separately accepted versioned change says otherwise.

For each case, record `case_id`, exact `base_sha`/`head_sha`, source/test path,
command, fixture checksum, adapter/client/platform/model configuration, outcome
(`pass`, `fail`, `unsupported`, `unrun`), bounded observation, remaining limitation
and receipt location. These are evaluation-report fields, not a production schema.
A case without execution stays unrun. Passing a docs link check is not L01 or S07.

Attach focused test, pinned typecheck/full-verifier and independent review receipts
to the owning PR. Native composition changes additionally need artifact-outside-
checkout proof. Live-client and human trials require actual observations. Do not
commit real transcripts, credentials, private paths, runtime databases or model
weights as proof. No final score can certify more than the tested configuration.
