import { exact, digest, equalJson, hash, reject } from "./native-proof-evidence";
import { NATIVE_LIMITS } from "./native-proof-process";

export const RETRIEVAL_CASES = [
  { title: "Orchard", query: "Orchrd", taint: "clean", authority: "model_inference", correction: false },
  { title: "Anemone", query: "Anemne", taint: "clean", authority: "owner_correction", correction: true },
  { title: "Violet", query: "Violett", taint: "quoted", authority: "connector_evidence", correction: false },
  { title: "Quasar", query: "Quasr", taint: "clean", authority: "owner_correction", correction: true },
] as const;
export const SOURCE_TITLES = ["SpruceQuill", "JuniperLoom"] as const;
export const ORIGINAL_MODEL_REF = "fixture:historical-egress-model";
export const ORIGINAL_BODY = "Synthetic restored journal interpretation.";
export const MODEL_NAME = "fixture-model";
export const JOURNAL_FIELDS = ["model_ref", "drafts", "model_inputs", "deferred_inputs", "integrity"] as const;
export type ScenarioId = "retrieval-authority-recovery" | "revocation-retained-consumers" | "pending-decision-restore";
export interface CommandRecipe { id: string; args: string[]; target: "vault" | "restored" | null; expected_exit: number }
export interface ToolRecipe { id: string; name: string; arguments: Record<string, unknown> }
interface CheckRecipe { id: string; predicate: "equal" | "positive" | "same-hash" | "different-hash" | "map" | "retrieval" | "diagnostic-retrieval" | "journal" | "replay"; expected?: unknown }
interface ScenarioRecipe { id: ScenarioId; fixtures: { id: string; action: string | null; target: "vault" | "restored" }[]; commands: CommandRecipe[]; tools: ToolRecipe[]; checks: CheckRecipe[] }
const fixture = (id: string, action: string | null = null, target: "vault" | "restored" = "vault") => ({ id, action, target });
const command = (id: string, args: string[], target: CommandRecipe["target"] = "vault", expected_exit = 0): CommandRecipe => ({ id, args, target, expected_exit });
const check = (id: string, expected: unknown): CheckRecipe => ({ id, predicate: "equal", expected });
const predicate = (id: string, kind: CheckRecipe["predicate"]): CheckRecipe => ({ id, predicate: kind });
const query = (id: string, text: string, target: CommandRecipe["target"] = "vault") => command(id, ["query", text, "--json", "--degraded"], target);
const stage = (name: string, exact: boolean, target: CommandRecipe["target"] = "vault") => RETRIEVAL_CASES.map(row => query(`${name}.${row.title}`, exact ? row.title : row.query, target));
const init = command("init", ["init", "$vault", "--no-default", "--no-service"], null);

const retrieval: ScenarioRecipe = {
  id: "retrieval-authority-recovery", fixtures: [fixture("source-model-canon", "seed-retrieval"), fixture("embedded-retrieval-selection"), fixture("restored-retrieval-selection", null, "restored")], tools: [],
  commands: [init,
    ...RETRIEVAL_CASES.filter(row => row.correction).map(row => command(`owner.${row.title}`, ["tell", `${row.title} now works at the synthetic conservatory.`, "--claim", `$claim.${row.title}`, "--json"])),
    command("floor-rebuild", ["rebuild", "--json"]), ...stage("floor-exact", true), ...stage("floor-typos", false),
    command("engine-rebuild", ["rebuild", "--json"]), ...stage("engine-typos", false),
    command("correct", ["tell", "Orchard now works at the synthetic conservatory.", "--claim", "$claim.Orchard", "--json"]), query("corrected-query", "Orchrd"),
    command("undo", ["undo", "$correction-receipt"]), query("undone-query", "Orchrd"),
    command("engine-rebuild-repeat", ["rebuild", "--json"]), ...stage("engine-after-undo", false),
    command("export", ["export", "--out", "$backup"]), command("restore", ["restore", "--from", "$backup", "--into", "$restored"]),
    command("restored-rebuild", ["rebuild", "--json"], "restored"), ...stage("restored-engine", false, "restored"),
  ],
  checks: [predicate("fixture-map", "map"), check("owner-receipts", 2), predicate("floor-exact", "retrieval"), predicate("floor-typos", "diagnostic-retrieval"),
    predicate("engine-typos", "retrieval"), check("correction-receipts", 1), check("corrected-authority", "owner_correction"), predicate("undo-bytes", "same-hash"),
    check("undone-authority", "model_inference"), predicate("engine-after-undo", "retrieval"), predicate("restored-engine", "retrieval")],
};
const revokeArgs = ["--source", "$source.SpruceQuill", "--operation-id", "fixture-native-revocation"];
const revocation: ScenarioRecipe = {
  id: "revocation-retained-consumers", fixtures: [fixture("grant.SpruceQuill", "grant-source"), fixture("claim.SpruceQuill", "seed-source-claim"), fixture("grant.JuniperLoom", "grant-source"), fixture("claim.JuniperLoom", "seed-source-claim"), fixture("historical-separate-fts", "seed-historical-fts"), fixture("embedded-retrieval-selection"), fixture("owned-ledger-claim-inspection", "inspect-purge")],
  commands: [init, ...SOURCE_TITLES.flatMap(title => [
    command(`enroll.${title}`, ["connect", "markdown-folder", "--source", `$notes.${title}`]),
    command(`denied.${title}`, ["backfill", "markdown-folder", "--source", `$source.${title}`], "vault", 1),
    command(`capture.${title}`, ["backfill", "markdown-folder", "--source", `$source.${title}`]),
    command(`retry.${title}`, ["backfill", "markdown-folder", "--source", `$source.${title}`]),
  ]), command("floor-rebuild", ["rebuild"]), command("engine-rebuild", ["rebuild"]),
    query("positive-revoked", SOURCE_TITLES[0]), query("positive-independent", SOURCE_TITLES[1]),
    command("positive-context", ["context", "--query", SOURCE_TITLES[0], "--budget", "1000", "--json"]),
    command("revoke", ["connect", "revoke", ...revokeArgs, "--expected-revision", "1", "--json"]),
    query("denied-query", SOURCE_TITLES[0]), command("denied-context", ["context", "--query", SOURCE_TITLES[0], "--budget", "1000", "--json"]),
    command("denied-recapture", ["backfill", "markdown-folder", "--source", "$source.SpruceQuill"], "vault", 1), query("retained-independent", SOURCE_TITLES[1]),
    command("resume-busy", ["connect", "resume-revocation", ...revokeArgs, "--json"], "vault", 1),
    command("resume-fresh", ["connect", "resume-revocation", ...revokeArgs, "--json"]),
    command("resume-retry", ["connect", "resume-revocation", ...revokeArgs, "--json"]), command("rebuild-after-purge", ["rebuild"]),
    query("purged-query", SOURCE_TITLES[0]), query("purged-independent", SOURCE_TITLES[1]), command("export", ["export", "--out", "$backup"]),
  ],
  tools: [
    { id: "positive-search", name: "search", arguments: { query: SOURCE_TITLES[0], scope: "all" } },
    { id: "positive-independent", name: "search", arguments: { query: SOURCE_TITLES[1], scope: "all" } },
    { id: "positive-context", name: "context_packet", arguments: { query: SOURCE_TITLES[0], purpose: "recall", budget_tokens: 1000 } },
    { id: "denied-search", name: "search", arguments: { query: SOURCE_TITLES[0], scope: "all" } },
    { id: "denied-context", name: "context_packet", arguments: { query: SOURCE_TITLES[0], purpose: "recall", budget_tokens: 1000, capabilities: ["delta"], retain_prefix: true, prior_hash: "$prefix.hash", epoch: "$prefix.epoch" } },
    { id: "retained-independent", name: "search", arguments: { query: SOURCE_TITLES[1], scope: "all" } },
    { id: "pending-search", name: "search", arguments: { query: SOURCE_TITLES[0], scope: "all" } },
  ],
  checks: [
    ...SOURCE_TITLES.flatMap(title => [check(`denied.${title}`, { reason: "source_capture_denied", captured: 0 }), check(`capture.${title}`, 1)]),
    predicate("fixture-map", "map"), check("historical-fts-positive", [1, 1]),
    predicate("cli-positive-revoked", "positive"), predicate("cli-positive-independent", "positive"), predicate("cli-positive-context", "positive"),
    predicate("mcp-positive-revoked", "positive"), predicate("mcp-positive-independent", "positive"), predicate("mcp-positive-context", "positive"),
    check("revocation-state", "pending"), check("cli-denied-query", 0), check("cli-denied-context", 0), check("recapture-reason", "source_capture_denied"), predicate("cli-retained-independent", "positive"),
    check("mcp-denied-query", 0), check("prefix-delivery", "full"), predicate("prefix-hash", "different-hash"), check("mcp-denied-context", 0), predicate("mcp-retained-independent", "positive"),
    check("busy-store", { purge: "pending", postgres: "pending" }), check("mcp-pending-query", 0),
    check("completed-stores", { purge: "complete", blockers: 0, stores: ["local:kizuki.retrieval.embedded-pg:maintained", "local:kizuki.retrieval.fts5:maintained"], existing_generations: 0 }),
    check("retry-state", "complete"), check("core-inspection", { revoked_events: 0, independent_events: 1, revoked_claim_mentions: 0 }),
    check("rebuilt-denied", 0), predicate("rebuilt-independent", "positive"), predicate("external-original", "same-hash"),
  ],
};
const pending: ScenarioRecipe = {
  id: "pending-decision-restore", fixtures: [fixture("constructed-pending-decision", "construct-pending"), fixture("missing-current-journal-copy"), fixture("simulated-v7-copy"), fixture("restored-journal-inspection", "inspect-journal", "restored"), fixture("restored-loopback-binding", null, "restored"), fixture("replay-inspection", "inspect-replay", "restored"), fixture("retry-inspection", "inspect-replay", "restored")], tools: [],
  commands: [init, command("export", ["export", "--out", "$backup"]),
    command("missing-journal", ["restore", "--from", "$missing-backup", "--into", "$missing-target"], "vault", 1),
    command("legacy-warning", ["restore", "--from", "$legacy-backup", "--verify"]), command("restore", ["restore", "--from", "$backup", "--into", "$restored"]),
    command("replay", ["serve", "run", "sync", "--json"], "restored"), command("retry", ["serve", "run", "sync", "--json"], "restored")],
  checks: [check("constructor", { model_calls: 1, allowed_inputs: 1, denied_inputs: 1, preexisting_queue: 1 }),
    check("backup-streams", { serve_version: 8, journals: 1, deferred: 1 }), predicate("exported-journal", "journal"),
    check("missing-journal-refusal", { reason: "backup durable extraction stream is missing", target_exists: false }),
    check("legacy-warning", "backup predates durable extraction recovery"), predicate("restored-journal", "journal"), check("restored-queue", 1),
    check("replay-model-requests", 0), predicate("replay-state", "replay"), check("retry-model-requests", 0), predicate("retry-state", "replay"),
    predicate("stable-claim", "same-hash"), predicate("stable-receipt", "same-hash"), predicate("stable-provenance", "same-hash")],
};
export const RECOVERY_RECIPE = { id: "kizuki.synthetic-native-recovery", version: 2, limits: NATIVE_LIMITS, scenarios: [retrieval, revocation, pending],
  scope: "synthetic-native-recovery", fixture_seams: "same-revision-core-and-constructed-extraction-journal", excluded_credits: ["real-account", "human", "calendar", "native-attestation", "installed-service", "comprehensive-residual-byte-scan", "reliable-crash", "historical-v7-recovery"] } as const;
export const RECOVERY_RECIPE_SHA256 = hash(JSON.stringify(RECOVERY_RECIPE));
export const RECOVERY_SUBGATES = ["retrieval-authority-undo-restore", "revocation-retained-session", "revocation-owned-store-recovery", "pending-decision-replay", "pending-backup-integrity"] as const;
export interface ObservedCheck { id: string; observed: unknown }

export function validateObservedCheck(scenario: ScenarioRecipe, row: ObservedCheck): void {
  exact(row, "id,observed"); const definition = scenario.checks.find(check => check.id === row.id);
  if (!definition) reject("unregistered-recovery-check");
  const value = row.observed;
  if (definition.predicate === "equal") { if (!equalJson(value, definition.expected)) reject("recovery-predicate-failed"); return; }
  if (definition.predicate === "positive") { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) reject("recovery-positive-control-missing"); return; }
  if (definition.predicate === "same-hash" || definition.predicate === "different-hash") {
    const hashes = exact(value, "before_sha256,after_sha256"); digest(hashes.before_sha256); digest(hashes.after_sha256);
    if ((hashes.before_sha256 === hashes.after_sha256) !== (definition.predicate === "same-hash")) reject("recovery-identity-mismatch"); return;
  }
  if (definition.predicate === "map") {
    const expected = scenario.id === retrieval.id ? RETRIEVAL_CASES.map(row => row.title) : [...SOURCE_TITLES];
    if (!Array.isArray(value) || value.length !== expected.length) reject("recovery-fixture-map-mismatch");
    const seen = new Set<string>();
    for (const [index, raw] of value.entries()) {
      const item = exact(raw, "case_id,event_sha256,claim_sha256,identity_sha256");
      if (item.case_id !== expected[index]) reject("recovery-fixture-map-mismatch");
      for (const key of ["event_sha256", "claim_sha256", "identity_sha256"]) { const identity = digest(item[key]); if (seen.has(identity)) reject("recovery-fixture-map-mismatch"); seen.add(identity); }
    }
    return;
  }
  if (definition.predicate === "retrieval" || definition.predicate === "diagnostic-retrieval") {
    if (!Array.isArray(value) || value.length !== 4) reject("recovery-case-set-mismatch");
    for (const [index, raw] of value.entries()) {
      const item = exact(raw, "case_id,rank,authority");
      if (item.case_id !== RETRIEVAL_CASES[index]!.title || !Number.isSafeInteger(item.rank) || (item.rank as number) < 0 || (item.rank as number) > 20) reject("recovery-case-result-invalid");
      if (definition.predicate === "retrieval" && item.rank !== 1) reject("recovery-recall-failed");
      if (item.authority !== (item.rank === 0 ? null : RETRIEVAL_CASES[index]!.authority)) reject("recovery-authority-mismatch");
    }
    return;
  }
  if (definition.predicate === "journal") {
    const fields = exact(value, JOURNAL_FIELDS.join());
    for (const field of JOURNAL_FIELDS) {
      const item = exact(fields[field], "before_sha256,after_sha256"); digest(item.before_sha256); digest(item.after_sha256);
      if (item.before_sha256 !== item.after_sha256 || (field === "model_ref" && item.before_sha256 !== hash(ORIGINAL_MODEL_REF))) reject("recovery-journal-mismatch");
    }
    return;
  }
  const state = exact(value, "model_claims,loop_receipts,pending_journals,deferred_ids_sha256,expected_deferred_ids_sha256,body_sha256,model_ref_sha256,receipt_model_ref_sha256,provenance_sha256,expected_provenance_sha256,receipt_provenance_sha256,claim_sha256,receipt_claim_sha256,receipt_sha256");
  if (state.model_claims !== 1 || state.loop_receipts !== 1 || state.pending_journals !== 0 || state.body_sha256 !== hash(ORIGINAL_BODY) || state.model_ref_sha256 !== hash(ORIGINAL_MODEL_REF) || state.receipt_model_ref_sha256 !== state.model_ref_sha256) reject("recovery-replay-state-mismatch");
  for (const key of ["provenance_sha256", "expected_provenance_sha256", "receipt_provenance_sha256", "claim_sha256", "receipt_claim_sha256", "receipt_sha256"]) digest(state[key]);
  if (state.provenance_sha256 !== state.expected_provenance_sha256 || state.receipt_provenance_sha256 !== state.provenance_sha256 || state.claim_sha256 !== state.receipt_claim_sha256) reject("recovery-replay-provenance-mismatch");
  for (const key of ["deferred_ids_sha256", "expected_deferred_ids_sha256"]) {
    const ids = state[key]; if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) reject("recovery-deferred-set-mismatch"); for (const id of ids) digest(id);
  }
  if (JSON.stringify(state.deferred_ids_sha256) !== JSON.stringify(state.expected_deferred_ids_sha256)) reject("recovery-deferred-set-mismatch");
}
