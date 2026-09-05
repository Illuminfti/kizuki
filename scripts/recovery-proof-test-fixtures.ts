/** Synthetic evaluator data only. No artifact is executed and no native receipt is issued. */
import { hash } from "./native-proof-evidence";
import { RECOVERY_RECIPE, RETRIEVAL_CASES, SOURCE_TITLES, JOURNAL_FIELDS, ORIGINAL_BODY, ORIGINAL_MODEL_REF } from "./recovery-proof-recipe";
import type { ScenarioObservation } from "./recovery-proof-scenarios";
const processResult = (exit = 0) => ({ exit_code: exit, wall_ms: 1, fault: null, stdout_bytes: 1, stderr_bytes: 0, stdout_sha256: hash("x"), stderr_sha256: hash("") });
const replay = () => ({ model_claims: 1, loop_receipts: 1, pending_journals: 0, deferred_ids_sha256: [hash("deferred-a"), hash("deferred-b")].sort(), expected_deferred_ids_sha256: [hash("deferred-a"), hash("deferred-b")].sort(),
  body_sha256: hash(ORIGINAL_BODY), model_ref_sha256: hash(ORIGINAL_MODEL_REF), receipt_model_ref_sha256: hash(ORIGINAL_MODEL_REF), provenance_sha256: hash("provenance"), expected_provenance_sha256: hash("provenance"), receipt_provenance_sha256: hash("provenance"), claim_sha256: hash("claim"), receipt_claim_sha256: hash("claim"), receipt_sha256: hash("receipt") });

/** Fabricated baseline qualifies only the validator; these bytes are never native execution proof. */
export function syntheticScenario(index: number): ScenarioObservation {
  const recipe = RECOVERY_RECIPE.scenarios[index]!;
  const result: ScenarioObservation = { id: recipe.id, fixtures: [], commands: [], tools: [], sessions: [], checks: [], failure: null }; let sequence = 0, request = 1;
  const tool = (id: string) => { const item = recipe.tools.find(tool => tool.id === id)!; result.tools.push({ ...item, sequence: ++sequence, session: 1, request_id: ++request, response_sha256: hash(id) }); };
  for (const item of recipe.commands) {
    if (item.id === "revoke") for (const id of ["positive-search", "positive-independent", "positive-context"]) tool(id);
    result.commands.push({ sequence: ++sequence, id: item.id, template: item.args, target: item.target, observation: processResult(item.expected_exit) });
    if (item.id === "retained-independent") for (const id of ["denied-search", "denied-context", "retained-independent"]) tool(id);
    if (item.id === "resume-busy") {
      tool("pending-search"); result.sessions.push({ sequence: ++sequence, ordinal: 1, request_ids: Array.from({ length: request }, (_, i) => i + 1), observation: processResult() });
    }
  }
  for (const item of recipe.fixtures) result.fixtures.push({ ...item, sequence: ++sequence, observation: item.action === null ? null : processResult() });
  for (const check of recipe.checks) {
    let observed: unknown;
    switch (check.predicate) {
      case "equal": observed = structuredClone(check.expected); break;
      case "positive": observed = 1; break;
      case "same-hash": case "different-hash": {
        const value = check.id === "stable-claim" ? "claim" : check.id === "stable-receipt" ? "receipt" : check.id === "stable-provenance" ? "provenance" : "original";
        observed = { before_sha256: hash(value), after_sha256: hash(check.predicate === "different-hash" ? "changed" : value) }; break;
      }
      case "map": observed = (index === 0 ? RETRIEVAL_CASES.map(row => row.title) : [...SOURCE_TITLES]).map(title => ({ case_id: title, event_sha256: hash(`${title}:event`), claim_sha256: hash(`${title}:claim`), identity_sha256: hash(`${title}:identity`) })); break;
      case "retrieval": case "diagnostic-retrieval": observed = RETRIEVAL_CASES.map(row => ({ case_id: row.title, rank: check.predicate === "retrieval" ? 1 : 0, authority: check.predicate === "retrieval" ? row.authority : null })); break;
      case "journal": observed = Object.fromEntries(JOURNAL_FIELDS.map(field => [field, { before_sha256: hash(field === "model_ref" ? ORIGINAL_MODEL_REF : field), after_sha256: hash(field === "model_ref" ? ORIGINAL_MODEL_REF : field) }])); break;
      case "replay": observed = replay(); break;
    }
    result.checks.push({ sequence: ++sequence, id: check.id, observed });
  }
  return result;
}
