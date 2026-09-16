# v2 Adaptive Domain World Models and Collaboration Model

Status: future v2 acceptance checklist for [issue #552](https://github.com/Illuminfti/kizuki/issues/552), a child of [#551](https://github.com/Illuminfti/kizuki/issues/551). This document supplies the checklist requested by #552; unchecked items are not implemented capabilities or accepted schemas. Kizuki remains a world model runtime for people. [#403](https://github.com/Illuminfti/kizuki/issues/403) remains the separate 1.0 stranger-readiness bar.

## Source receipts and authority

The source of this checklist is the owner intent and numbered scope recorded in [#552](https://github.com/Illuminfti/kizuki/issues/552). That issue cites the [originating conversation](https://chatgpt.com/c/6a9dbdde-2d54-83ea-a459-01d2e942dcc2). The conversation and its private packet were not independently inspected for this document. These are paraphrases of the issue, not new verbatim owner quotations or claims to have verified external research.

Receipt keys below refer to the issue's sections:

- T1–T5: the five numbered entries under “Real Illumi turns (verbatim intent)”. T1 requests deeper knowledge and developing taste around interests; T2 requires this in v2; T3 requests GitHub tracking; T4 requests evidence-backed models and bounded prediction; T5 requests task-aware collaboration context beyond a static profile.
- A1–A7: the seven numbered items under “Scope A — Adaptive Domain World Models”.
- B1–B7: the seven numbered items under “Scope B — Collaboration Model via World Slices”. The issue labels these shapes as assistant steals, not owner quotations.

[RFC 0002](../rfcs/0002-autonomous-canon.md), [current direction](CURRENT.md), [decision log](decision-log.md) and [architecture](architecture.md) govern implementation. This checklist does not amend them. Reuse the [world model program](world-model-program.md) and its existing claim, provenance and permission boundaries; do not create another product tree, agent runtime, or independent profile store.

## Scope A acceptance checklist

Each item requires implementation evidence before it can be checked. All examples below are synthetic acceptance scenarios, not observations of a person.

- [ ] A1 — Interest detection. Record explicit questions, sustained attention, selections and corrections with their source evidence and time. An isolated design-page visit remains an interest hypothesis; repeated independent evidence can deepen it without presenting attention as competence. A later owner correction supersedes the interest interpretation. Receipt: T1, T4, A1.
- [ ] A2 — Domain graphs. Represent concepts, experts, examples, frameworks, evidence, timeline, open questions and developing taste as linked facets of the existing world model. A design-framework query can trace each returned facet and relationship to permitted evidence. An unknown facet is reported as unknown, not filled with invented expertise. Receipt: T1, A2.
- [ ] A3 — Bounded expansion. As evidenced interest grows, expand knowledge only through explicitly configured sources and model endpoints, within declared resource and write budgets. The owner can inspect the trigger, sources, costs and resulting receipts, stop further learning and undo its writes. Missing permission or an exhausted budget stops expansion; it never silently enables a connector or spends beyond the configured limit. Receipt: T1, T4, A3.
- [ ] A4 — Per-domain taste. Preserve accepted and rejected examples plus the owner's reasons, domain, context, provenance and uncertainty. A preference for sparse poster layouts must not become a universal preference for sparse technical documentation. Acceptance of an example is evidence about taste, not a canon approval queue. Receipt: T1, A4.
- [ ] A5 — Cross-domain links. Connect a domain facet to relevant people, projects, companies or ideas through source-backed claims. A design-to-project link is reversible and permission-filtered at both ends; similarity alone does not establish identity or an observed relationship. Receipt: T4, A5.
- [ ] A6 — Task-bound domain slices. Compile the permitted domain knowledge and taste that change a justified decision for the requested task. A poster task receives relevant layout examples and reasons, not unrelated personal history. Missing or revoked source access removes dependent content and does not widen the query scope. Receipt: T5, A6.
- [ ] A7 — Depth and stopping. Expose evidenced coverage, freshness, unanswered questions and learning expenditure rather than equating record count with understanding. A configured learning ceiling or owner stop prevents further expansion; inspect, correction and receipted undo remain available. Replaying generated summaries must not increase evidence depth. Receipt: T1, T4, A7.

## Scope B acceptance checklist

- [ ] B1 — Six collaboration areas. Support communication, work standards, collaboration protocol, knowledge, decision values and developing taste as separately scoped, evidence-backed facets. A fixture with evidence for each area can recover each facet; absent evidence in any area stays unknown. No area is a personality diagnosis. Receipt: T5, B1.
- [ ] B2 — Person × task compilation. Select only context that changes a justified agent decision, within the current task and grant. With the same person evidence, a short status update and a detailed technical review produce different relevant guidance. Unrelated private context must not influence selection, ranking, counts or explanations. Receipt: T5, B2.
- [ ] B3 — Progressive connection-time learning. Prioritize high-information permitted evidence at connection time and become useful before historical ingestion completes. Preserve resumable progress and distinguish unavailable evidence from an empty result. One weak signal remains a hypothesis; repeated copies of it do not count as independent support. Receipt: T5, B3.
- [ ] B4 — Typed conditional records. Preserve a record's area, condition, scope, supporting evidence, uncertainty, exceptions and temporal applicability. Validate the representation before serving it. “Use brief updates except during incident analysis” must retain its exception; missing provenance excludes a record. These are required semantics, not a new schema registered by this document. Records never grant tools, source access or external-action authority. Receipt: T5, B4.
- [ ] B5 — Brief, examples and rubric. Compile a concise task brief, permitted positive/negative examples with reasons, and acceptance criteria grounded in the same evidence. Each element remains traceable and bounded; conflicting or insufficient evidence is explicit. A rubric cannot turn an inferred taste into a hard owner instruction. Receipt: T5, B5.
- [ ] B6 — Cross-agent learning. Link the served slice, agent work, user edits and observed outcomes through provenance. Agent B's next authorized slice reflects a correction to Agent A's work; repeated delivery is idempotent. An agent's claim of success is not an independently observed outcome or owner endorsement. Purge, correction and undo invalidate dependent guidance without resurrecting removed evidence. Receipt: T5, B6.
- [ ] B7 — Harness-neutral personalization. Define the host integration contract for requesting task context, presenting brief/examples/rubric and refreshing stale slices using current grants. Two authorized hosts can consume the same permitted semantics without per-user fine-tuning or a hosted agent loop. Changing a host or granting read access never grants action authority; unsupported behavior is explicit rather than a fake public surface. Receipt: T5, B7.

## Shared acceptance and completion boundary

For every implemented item, attach the exact revision, changed paths, synthetic success and refusal cases, and real test results to #552 or its linked implementation PR. An item needs evidence of provenance, current permissions, bounded work and correction/undo behavior wherever those apply. Acceptance text alone earns no runtime completion credit.

World Slices must apply grants, source consent and sensitivity before discovery, traversal, ranking and compression. Private evidence cannot leak through example selection, omitted-record counts or change signals. Weak inference remains a hypothesis; generated output cannot corroborate itself. Grounded reaction predictions remain conditional analyses with evidence and uncertainty, never profiling or mind-reading.

Canon continues through the single receipted writer; there is no owner review queue. Permission for a source is distinct from approval of individual knowledge writes. Capture, ledger, search, timeline, context, audit and undo retain the deterministic floor; autonomous canon writing still requires a configured model. No inferred interest authorizes silent network egress or external actions.

The checklist covers A1–A7 and B1–B7 for v2 as requested by T2 and T3. It does not authorize a new schema, migration, connector, command, model purchase or execution runtime. Backup/restore #536, launch #403, monetization and estate cutover remain separate. Live progress belongs in #552; merging this document records acceptance requirements, not completion of v2.
