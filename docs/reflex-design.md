# Reflex: decision maintenance, not another memory chatbot

## Product thesis

The highest-leverage use of a narrow typed model in Kizuki is to make remembered decisions responsive to change. Retrieval answers “What did we know?” Reflex asks “What no longer follows, and which agent plans rely on it?”

The proposed long-term experience is a read-only reflex layer across authorized agent context: changed evidence nominates remembered assumptions; narrow judgments assess the relationship; a cited dependency graph identifies affected decisions and proposed actions; an agent receives a compact explanation and refreshed context rather than repeating an obsolete commitment. Kizuki remains memory infrastructure, not a host for those agents.

Examples are design scenarios, not claims about the owner's current projects: a release gate becomes false and launch commitments need revalidation; a customer commitment changes and an outreach plan is stale; an integration becomes hosted and privacy statements or consent assumptions no longer fit. The supplied demonstration implements the third scenario with synthetic data.

The standout interaction is “What if this assumption changes?” It should reveal an inspectable impact map before a change is adopted. The implemented counterfactual mode does exactly that on a supplied dependency snapshot; it does not predict consequences beyond the graph or assert that the hypothetical happened.

## Why Jev fits

TypeSafe's current API accepts multiple Noul, Choice and Score questions in one `state`/`questions` request to `/v1/systemone`. This is a good shape for bounded parallel classification, uncertainty and triage, rather than free-form prose generation. Kizuki already exposes the compatible `kizuki.systemone/v1` contract and an optional extracted-claim admission function. Reflex reuses that contract through the public core export and an injected existing port instead of creating a second client.

The five-role workflow is relation, evidence support, applicability, counterevidence and consequence. It is not five independent models. Hard validation, deterministic graph mechanics and existing authorization must do the jobs that probabilistic judgments cannot.

## Implemented slice versus complete product

Implemented: a transport-free TypeScript analysis package; explicit host/egress adapter; strict runtime response checks; bounded scheduling; timeout and stale-result behavior; dependency propagation; complete path provenance; revision-aware advisory preflight; a model-free counterfactual; synthetic CLI and interactive HTML demonstrations; focused tests and verification evidence.

Not implemented: authoritative host snapshot construction, live serving/MCP registration, real vault monitoring, automatic graph discovery, durable subscriptions, a production impact inbox, or a release-ready integration. No real Jev request was made. This branch preserves the experimental package for review; it does not activate live-vault behavior. See [the verification receipt](reflex-verification.md) for the tested scope and remaining gates.

## Evaluation before activation

Use a pinned model and a labeled, consented holdout set. Include contradictory, superseding, corroborating, unrelated, hypothetical, quoted-instruction, ambiguous-identity and temporal-scope cases. Evaluate candidate retrieval separately from relationship classification: perfect judgments cannot recover an omitted candidate. Report precision/recall and abstention per consequence tier rather than just a single accuracy average.

Replay dependency snapshots with an independent reachability oracle. Measure source-policy changes and corrections during evaluation, not only before it. Measure provider latency and billed usage separately from deterministic projection time. Treat disagreement among questions from one model as useful uncertainty, not an independent ensemble confidence estimate.

Start as opt-in read-only advice for already-authorized context. Keep canon mutation and tool execution under their existing authorities. No general claim of “orders of magnitude better” is justified without a task-specific baseline and a measured comparison.

## Primary references checked 2026-09-17

- TypeSafe quickstart: https://docs.typesafe.ai/introduction/quickstart
- Confidence semantics: https://docs.typesafe.ai/confidence
- Speculative fan-out: https://docs.typesafe.ai/patterns/fan-out
- Existing Kizuki contract: packages/core/src/contracts/systemone.ts
- Existing admission: packages/core/src/producer/systemone-admit.ts
- Core export: packages/core/src/contracts/index.ts
- Product/authority instructions: docs/CURRENT.md, AGENTS.md, packages/core/AGENTS.md

The live repository was read through the GitHub connector. The implementation environment could not clone it. The verification fixture reproduces the request/response type surface needed by this package; it is not a full core checkout.

## Related implementation

[PR #944](https://github.com/Illuminfti/kizuki/pull/944) already proposes a core/CLI evidence-before-action slice. Its files and branch are untouched. This package uses `kizuki.reflex-impact/v1` so its dependency-impact report cannot be confused with the other draft's differently shaped `kizuki.reflex/v1`. Reconcile the host adapter, report interfaces and product surface before merging both into a production journey.
