import { createHash } from "node:crypto";
import type { SystemOnePort, SystemOneResponse } from "../../src/contracts/systemone";
import { evaluateMatrix, reduceFindings } from "../../src/reflex/engine";
import { REFLEX_POLICY } from "../../src/reflex/types";
import type { ReflexAssumption, ReflexEvidence, ReflexRelation, ReflexReport } from "../../src/reflex/types";

/** Scripted synthetic matrix. This is a rendering/contract fixture, not a semantic benchmark. */
export async function syntheticReflexReport(): Promise<ReflexReport> {
  const assumptions: ReflexAssumption[] = [
    { id: "launch", statement: "We can launch the campaign on Friday.", importance: "critical" },
    { id: "budget", statement: "The approved campaign budget is £4,000.", importance: "normal" },
    { id: "audience", statement: "The customer mailing list is approved for this campaign.", importance: "critical" },
  ];
  const raw = [
    ["launch-notes", "The campaign is approved for Friday."],
    ["launch-correction", "Hold the Friday launch. The final review is not complete."],
    ["budget-note", "The campaign budget is approved at £4,000. Mailing list approval is still unclear."],
  ];
  const texts = raw.map(([event_id, text]) => ({
    event_id: event_id!, text: text!, occurred_at: "2026-09-17T10:00:00Z", sensitivity: "public" as const,
    eligibility: "eligible" as const, sha256: createHash("sha256").update(text!).digest("hex"),
  }));
  const labels: ReflexRelation[][] = [["supports", "contradicts", "irrelevant"], ["irrelevant", "irrelevant", "supports"], ["irrelevant", "irrelevant", "unclear"]];
  const scripted: SystemOnePort = {
    model_ref: "synthetic-fixture", descriptor: { id: "kizuki.systemone.fixture", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    evaluate: async req => ({
      model: "synthetic-fixture", usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(req.questions).map(key => {
        const match = /^a(\d+)_e(\d+)$/.exec(key)!;
        const label = labels[Number(match[1])]![Number(match[2])]!;
        return [key, { type: "choice", choice: label, confidence: 0.94, probabilities: Object.fromEntries(["supports", "contradicts", "irrelevant", "unclear"].map(r => [r, r === label ? 0.97 : 0.01])) }];
      })),
    } as SystemOneResponse),
  };
  const result = await evaluateMatrix({ assumptions, evidence: texts }, scripted, Date.now() + 1000, () => true);
  const evidence: ReflexEvidence[] = texts.map(({ text: _, ...metadata }) => metadata);
  return {
    schema: "kizuki.reflex/v1", policy: REFLEX_POLICY, status: result.status, reason: result.reason,
    authority: "advisory_only", requires_revalidation: true,
    snapshot: { at: "2026-09-17T12:00:00Z", valid_until: "2026-09-17T12:01:00Z", principal: "Synthetic demo", source_epoch: 1, claims_epoch: 1, digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), model_binding: "synthetic-no-network" },
    coverage: { requested_events: 3, readable_events: 3, examined_events: result.status === "assessed" ? 3 : 0, exhaustive: false },
    model: result.model, evidence, matrix: result.cells, findings: reduceFindings(assumptions, result.cells), metrics: result.metrics,
  };
}
