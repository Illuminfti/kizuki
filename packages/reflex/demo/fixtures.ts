import type { Change, Snapshot } from "../src/types";
import type { SystemOneResponse } from "../src/systemone";
import { CONSEQUENCE_LEVELS } from "../src/systemone";

/** Entirely synthetic. Never a sample of an owner's vault. */
export function fixture() {
  const snapshot: Snapshot = {
    binding: { snapshot_id: "snapshot:test", principal_id: "agent:test", policy_epoch: 7, expires_at: "2099-01-01T00:00:00Z" },
    nodes: [
      { id: "fact:local", kind: "fact", revision: "r1", statement: "The optional classifier processes all source text locally.", evidence_ids: ["event:old"], consequence: 2 },
      { id: "decision:privacy", kind: "decision", revision: "r2", statement: "Describe classification as on-device in launch materials.", evidence_ids: ["claim:privacy"], consequence: 3 },
      { id: "decision:consent", kind: "decision", revision: "r3", statement: "The classifier does not need a model-egress source grant.", evidence_ids: ["claim:consent"], consequence: 4 },
      { id: "action:website", kind: "action", revision: "r4", statement: "Publish the on-device-only classification promise.", evidence_ids: ["claim:website"], consequence: 3 },
      { id: "action:enable", kind: "action", revision: "r5", statement: "Turn on the optional classifier without checking model-egress grants.", evidence_ids: ["claim:enable"], consequence: 4 },
      { id: "action:lint", kind: "action", revision: "r6", statement: "Run local typecheck.", evidence_ids: ["claim:lint"], consequence: 1 },
    ],
    dependencies: [
      { prerequisite: "fact:local", dependent: "decision:privacy", evidence_ids: ["edge:privacy"] },
      { prerequisite: "fact:local", dependent: "decision:consent", evidence_ids: ["edge:consent"] },
      { prerequisite: "decision:privacy", dependent: "action:website", evidence_ids: ["edge:website"] },
      { prerequisite: "decision:consent", dependent: "action:enable", evidence_ids: ["edge:enable"] },
    ],
  };
  const change: Change = { id: "event:config-change", occurred_at: "2026-09-17T10:00:00Z",
    statement: "The classifier configuration now sends source text to a hosted API. It is not on-device.",
    evidence_ids: ["event:config-change"], target_ids: ["fact:local"] };
  return { snapshot, change };
}
export function response(choice = "contradicts"): SystemOneResponse {
  return {
    model: "scripted-fixture-not-jev",
    answers: {
      relation: { type: "choice", choice, probabilities: Object.fromEntries(["contradicts", "supersedes", "supports", "unrelated", "unknown"].map((key) => [key, key === choice ? 0.96 : 0.01])), confidence: 0.9 },
      supported: { type: "noul", noul: 0.97 }, applicable: { type: "noul", noul: 0.97 }, counterevidence: { type: "noul", noul: 0.02 },
      consequence: { type: "score", score: 3, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
        legend: Object.fromEntries(CONSEQUENCE_LEVELS.map((text, index) => [String(index), text])), confidence: 1 },
    }, usage: { input_tokens: 100, output_tokens: 20 },
  };
}
