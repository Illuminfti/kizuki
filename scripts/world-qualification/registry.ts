import { createWorldRegistry, type WorldRegistry, type WorldVocabularyModule } from "../../packages/core/src/contracts/world-kinds";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import baseline from "./preexisting.json";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { qualificationCorpus } from "./corpus";
import { caseInput, responseMeanings, scoreRun } from "./score";
import { runnerDigest } from "./fingerprint";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import type { runQualification } from "./run";
import { REVIEWED_QUALIFICATIONS, type QualificationApproval } from "./approvals";
export { REVIEWED_QUALIFICATIONS, type QualificationApproval } from "./approvals";

export const registryDigest = (registry: WorldRegistry) => sha256(canonicalJson({
  kinds: registry.kinds.filter(row => row.offeredToProducer), offered: registry.offered,
}));

/** Isolated evaluation only. The caller passes actual registered modules; absent product kinds cannot be fabricated. */
export function candidateRegistry(modules: readonly WorldVocabularyModule[], kinds: readonly string[], extensions: readonly string[] = []): WorldRegistry {
  if (new Set(kinds).size !== kinds.length || kinds.some(kind => !modules.some(module => module.kind?.id === kind))) throw new Error("unregistered candidate kind");
  if (new Set(extensions).size !== extensions.length || extensions.some(id => !modules.some(module => module.kind === null && module.predicates[0]?.predicate === id))) throw new Error("unregistered candidate extension");
  return createWorldRegistry(modules.map(module => module.kind !== null ? kinds.includes(module.kind.id)
    ? { ...module, kind: { ...module.kind, offeredToProducer: true } } : module
    : extensions.includes(module.predicates[0]?.predicate ?? "") ? { ...module, offeredToProducer: true } : module));
}

/** Only a reviewed receipt verifier can create this in memory; response-file assertions cannot. */
const CHECKED = new WeakSet<object>();
export interface CheckedQualification { registry_sha256: string; report_sha256: string; kinds: readonly string[]; predicates: readonly string[] }

export function verifyQualificationReceipt(bytes: string, approval: QualificationApproval, registry: WorldRegistry, root?: string): CheckedQualification {
  if (!/^[a-f0-9]{64}$/.test(approval.sha256) || sha256(bytes) !== approval.sha256 || !/^[a-f0-9]{64}$/.test(approval.endpoint_evidence)) throw new Error("qualification review pin mismatch");
  const report = JSON.parse(bytes) as Awaited<ReturnType<typeof runQualification>>;
  if (report.schema !== "kizuki.world-qualification-run/v1" || report.evidence !== "runner_observed_transport" || report.synthetic !== true ||
      report.source_clean !== true || !/^[a-f0-9]{40}$/.test(report.source_commit) || report.runner_sha256 !== runnerDigest(root) ||
      report.registry_sha256 !== registryDigest(registry) || report.missing.length !== 0 || !report.model || !report.endpoint_host ||
      canonicalJson(report.corpus) !== canonicalJson(qualificationCorpus)) throw new Error("qualification source or corpus mismatch");
  const score = scoreRun(qualificationCorpus, report.observations);
  if (canonicalJson(score) !== canonicalJson(report.score) || report.selected_kinds.length === 0 || new Set(report.selected_kinds).size !== report.selected_kinds.length ||
      report.selected_kinds.some(kind => !score.kinds.some(row => row.kind === kind && row.status === "passed"))) throw new Error("qualification score failed");
  if (report.traces.length !== report.observations.length || report.traces.length > 100) throw new Error("qualification trace count mismatch");
  for (const observed of report.observations) {
    const item = qualificationCorpus.cases.find(row => row.id === observed.case_id)!;
    const expectedInput = caseInput(item, registry);
    if (!report.selected_kinds.includes(item.kind) || canonicalJson(expectedInput) !== canonicalJson(observed.input) ||
      sha256(extractionV2SystemContent(expectedInput)) !== report.prompt_sha256_by_case[item.id]) throw new Error("qualification input mismatch");
    const traces = report.traces.filter(row => row.case_id === item.id);
    const trace = traces[0];
    if (traces.length !== 1 || trace === undefined || trace.transport !== "ok" || trace.prompt_sha256 !== report.prompt_sha256_by_case[item.id] || !/^[a-f0-9]{64}$/.test(trace.request_sha256) || trace.response_sha256 === null || !/^[a-f0-9]{64}$/.test(trace.response_sha256) ||
      !Number.isFinite(Date.parse(trace.started_at)) || trace.completed_at === null || !Number.isFinite(Date.parse(trace.completed_at)) || Date.parse(trace.completed_at) < Date.parse(trace.started_at)) throw new Error("qualification transport evidence missing");
  }
  for (let index = 1; index < report.traces.length; index++) if (Date.parse(report.traces[index]!.started_at) - Date.parse(report.traces[index - 1]!.started_at) < 60_000) throw new Error("qualification pacing violated");
  // Positive observed tuples, not optional oracles, establish which changed predicates were exercised.
  const predicates = [...new Set(report.observations.flatMap(observed => {
    const item = qualificationCorpus.cases.find(row => row.id === observed.case_id)!;
    const required = new Set(item.required.flatMap(alternatives => alternatives.map(row => row.predicate)));
    return responseMeanings(item, observed.response!).filter(row => required.has(row.predicate)).map(row => row.predicate);
  }))];
  const result = { registry_sha256: report.registry_sha256, report_sha256: approval.sha256, kinds: report.selected_kinds, predicates };
  CHECKED.add(result);
  return result;
}

export function loadReviewedQualifications(root: string, registry: WorldRegistry): CheckedQualification[] {
  return REVIEWED_QUALIFICATIONS.map(approval => {
    if (!/^[a-z0-9-]+\.json$/.test(approval.file)) throw new Error("invalid reviewed qualification filename");
    const fd = openSync(join(root, "scripts/fixtures/world-qualification", approval.file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("invalid reviewed qualification file");
      return verifyQualificationReceipt(readFileSync(fd, "utf8"), approval, registry, root);
    } finally { closeSync(fd); }
  });
}

export function checkOfferedQualification(registry: WorldRegistry, qualifications: readonly CheckedQualification[]): void {
  const approved = qualifications.filter(row => CHECKED.has(row) && row.registry_sha256 === registryDigest(registry));
  const allowedKinds = new Set(approved.flatMap(row => row.kinds));
  const allowedPredicates = new Set(approved.flatMap(row => row.predicates));
  const changed: string[] = [];
  for (const kind of registry.kinds.filter(row => row.offeredToProducer)) {
    if (!baseline.kinds.some(row => row.id === kind.id && row.sha256 === sha256(canonicalJson(kind))) && !allowedKinds.has(kind.id)) changed.push(`kind:${kind.id}`);
  }
  for (const predicate of registry.offered.vocabulary.filter(row => row.predicate !== "world.kind")) {
    if (baseline.predicates.some(row => row.id === predicate.predicate && row.sha256 === sha256(canonicalJson(predicate)))) continue;
    if (!allowedPredicates.has(predicate.predicate)) changed.push(`predicate:${predicate.predicate}`);
  }
  if (changed.length > 0) throw new Error(`unqualified offered vocabulary: ${changed.join(", ")}`);
}
