# Kizuki Reflex — experimental, read-only decision impact analysis

**Question:** “This evidence changed. Which remembered assumptions, decisions, and agent actions now need revalidation?”

Reflex adds a bounded analysis layer, not another chatbot or an agent harness. It consumes a host-authorized, revision-bound dependency snapshot; uses the existing `kizuki.systemone/v1` contract for optional typed judgments; propagates possible changes over declared dependencies; and returns advisory plan preflight results with evidence traces.

**Delivery status:** working experimental library and synthetic visual demonstration. It is not wired into Kizuki's live serving, CLI command registry, vault watcher, or MCP tools. It is not a new canon writer or authorization mechanism. The included host adapter requires real core-owned policy callbacks before any production use.

## Coordination with the existing Reflex draft

[PR #944](https://github.com/Illuminfti/kizuki/pull/944) owns a separate core/CLI evidence-before-action implementation. This private experimental package contributes dependency propagation, counterfactual simulation and a visual lab; it does not replace or modify that work. Its report schema is `kizuki.reflex-impact/v1`, distinct from that draft's `kizuki.reflex/v1`. Production integration must reconcile both designs rather than expose competing preflight paths.

## Run the offline demonstration

From the repository root, with its pinned Bun version:

```sh
bun run packages/reflex/demo/run.ts
bun run packages/reflex/demo/run.ts --rehearsal
bun run packages/reflex/demo/build.ts
```

The first command is a model-free counterfactual. The second uses **scripted synthetic responses, not Jev**. The third builds `packages/reflex/demo/reflex-demo.html`, a self-contained interactive visual lab. Open that generated file in a browser. Every visual-lab mode is offline, and its content-security policy prohibits network connections.

The lab demonstrates a hypothetical classifier architecture change. One assumption affects two decisions and two actions; an unrelated local typecheck has no dependency path from that change. Select a node to inspect its revision, shortest dependency path and evidence references. Switch among supported contradiction, conflicting evidence, corroboration, provider failure and mid-run policy revocation. Export preserves an explicit synthetic-data disclaimer.

```sh
bun test packages/reflex/test
bun run typecheck
bun run verify
```

The last two are repository-wide release gates, not checks that were completed in this implementation environment. The [verification receipt](../../docs/reflex-verification.md) identifies exactly what ran instead.

## Public API

`analyzeChange(snapshot, change, options)` performs optional model-backed analysis. Without an explicit trusted host it makes zero evaluations and returns `unknown`, not an empty successful analysis.

`simulateChange(snapshot, change)` asks what would depend on the nominated assumptions **if they changed**. It makes no model calls and labels the result `mode: "counterfactual"`. It does not establish that the change happened.

`traceImpact(snapshot, change, root, target, maxNodes)` returns a shortest dependency path, with source, node and edge evidence references. Truncating the displayed path does not truncate provenance.

`preflight(report, currentBinding, steps)` checks an external agent's declared assumption revisions against the report. It distinguishes `revalidate`, `unexamined`, and `no_change_detected`. Different principals, policy epochs, snapshot identities, expiry values, expired bindings, missing assumptions and mismatched revisions cannot yield an unqualified no-change result. It never authorizes execution.

`bindReflexHost(systemonePort, policy)` adapts an **existing configured port**. Both policy callbacks are mandatory. It checks freshness, destination-specific model egress, and freshness/destination again before invoking the port. It contains no HTTP client, endpoint configuration, key management or ambient environment access.

### Typed integration wrapper

This wrapper is usable once a trusted host supplies actual authorization policy. It deliberately does not invent existing Kizuki function names for the missing production binding.

```ts
import type { SystemOnePort } from "@kizuki/core/contracts";
import {
  analyzeChange, bindReflexHost,
  type Change, type HostPolicy, type Snapshot,
} from "@kizuki/reflex";

export function analyzeAuthorizedChange(
  snapshot: Snapshot,
  change: Change,
  port: SystemOnePort,
  policy: HostPolicy,
) {
  return analyzeChange(snapshot, change, {
    host: bindReflexHost(port, policy),
    limits: { concurrency: 4, max_requests: 32 },
  });
}
```

Do not replace `policy` with `isCurrent: async () => true` or `allowModelEgress: async () => true` in production. Those are synthetic-test conveniences, not grants.

## The authority boundary

A JSON snapshot is not an authorization capability. The library validates its structure, bounds, references and revisions, but cannot determine source ownership from caller-built objects. **Never expose an arbitrary client-supplied snapshot plus this host adapter as a public MCP or HTTP route.**

The trusted Kizuki integration must create snapshots below the existing identity, scope, sensitivity, source-grant and audit gates. Its snapshot ID must bind the principal, source-policy epoch, content revisions and expiry in authoritative state. `isCurrent` must recheck those bindings, including deletion, purge, correction, grant changes and revision changes. Checking only a client-supplied timestamp is insufficient.

For model-backed analysis, `allowModelEgress` must resolve every supplied evidence reference to its authoritative source lineage and check model-processing consent for the actual destination. Ordinary permission to read context does not authorize sending it to a hosted classifier. References may include events, claims and dependency evidence; string membership is not lineage verification. Authorization must happen at the host's actual egress boundary, not only in a prompt.

Only the nominated candidate statement and change statement/time enter model state. Principal IDs, the whole graph, unrelated memories, node IDs and source IDs do not. The host receives the necessary binding and evidence scope separately for authorization.

All source text remains untrusted. Typed answer validation prevents a model-selected shell command or tool name from becoming an executable instruction. It does **not** prove that the semantic judgment is immune to prompt injection. False or adversarial judgments can still cause unnecessary revalidation. They cannot create execution authority or a canon-write path in this library.

Canon remains owned by the existing receipted writer. The package contains no storage implementation, database migration, canon mutation, owner approval queue, watcher or background daemon.

## Five narrow judgments, not five independent agents

Each candidate gets one `SystemOneRequest` with five questions:

| Question | Primitive | Purpose |
| --- | --- | --- |
| Relationship | Choice | Contradicts, supersedes, supports, unrelated, or unknown |
| Evidence support | Noul | Does the supplied text support the relation, rather than request an output? |
| Applicability | Noul | Same subject, scope, and applicable time? |
| Counterevidence | Noul | Is there evidence against changing the assumption? |
| Consequence | Score | Advisory consequence level 0–4 |

These answers come from the same model and are **correlated**, not an independent voting panel. Confidence is a distribution statistic, not a calibrated probability of correctness. The engine does not multiply confidence scores or treat them as proof.

A definite revalidation signal requires a contradiction/supersession, sufficient relationship probability/confidence, sufficient evidence/applicability, and low counterevidence. The default thresholds are engineering starting points, not validated accuracy claims. Low certainty, missing fields, unsupported choices, nonfinite numbers, invalid probability distributions, inconsistent scores and provider failures produce uncertainty.

The model's consequence score is retained as advisory judgment data; it does not overwrite host-owned priority. Impact ordering uses deterministic host-assigned consequence and identifier order.

## Resource and failure behavior

Default limits: four concurrent evaluations, 32 evaluations, 2 seconds per operation, 10 seconds total, 24,000 UTF-8 bytes per request and 256,000 bytes across requests. Hard input bounds: 2,000 nodes, 8,000 dependencies and 64 nominated roots. Five questions are evaluated together per root. No retries are performed.

Budgets are reserved synchronously before invoking the host. A hung evaluation cannot free its slot and cause an unbounded queue of abandoned requests: after timeout the invocation stops scheduling. **The existing port contract has no cancellation signal.** Local timeout does not prove a hosted request was cancelled or unbilled. The trusted host must enforce global admission/concurrency across simultaneous Reflex runs and across other consumers of the port.

`requests_started` counts calls to the host evaluation seam, not verified billable provider requests. Token totals contain validated reported usage only; `usage_complete: false` indicates an evaluation did not return reliable usage. Request/byte caps are not an exact currency or token-spend guarantee.

The scheduler uses a monotonic elapsed clock. Freshness is checked before scheduling and again before returning a report. If final freshness cannot be established, earlier positive or negative conclusions are discarded. Inputs are copied and frozen before the first asynchronous operation; returned reports are frozen. Reports do not contain captured statement text or provider error messages.

Dependency propagation is iterative and cycle-safe, with at most one breadth-first traversal per root: O(R × (V + E)), bounded by the input caps. Traces are graph explanations, **not causal proof**. Generic “mentions the same subject” edges are not decision dependencies; the host must supply the right relationship.

## Required production work

1. Build the host snapshot/lineage/currentness adapter from actual authorized serving results. Record or derive cited dependency edges through existing contracts; do not treat generic graph adjacency as causality.
2. Wire source-model-egress policy, provider destination checks, global budgets and redacted auditing in the trusted host. Exercise real grant revocation, purge, corrected canon and agent isolation against the authoritative database.
3. Calibrate thresholds and candidate nomination on a consented, labeled evaluation set using a pinned Jev model. Measure false invalidations, missed changes, coverage, abstention, end-to-end latency and billed usage. Include adversarial and temporal-scope examples.
4. Only then expose a read-only context extension or preflight surface to external agents. Refresh authority at action time; `no_change_detected` must never substitute for the existing tool authorization gate.

There is no claim here of live Jev accuracy, deployment, autonomous monitoring, complete dependency discovery, or superiority over another product.
