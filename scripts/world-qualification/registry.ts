import { createWorldRegistry, type WorldRegistry, type WorldVocabularyModule } from "../../packages/core/src/contracts/world-kinds";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import baseline from "./preexisting.json";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { qualificationCorpus } from "./corpus";
import { caseInput, responseMeanings, scoreRun } from "./score";
import { scoreSupplementalRun, validateFreshCore } from "./supplemental";
import { runnerDigest } from "./fingerprint";
import { validateResume } from "./resume";
import { RESPONSE_GAP_MS } from "./pacing";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import type { runQualification } from "./run";
import { REVIEWED_QUALIFICATIONS, type QualificationApproval } from "./approvals";
import { CORE_SEMANTIC_PROTOCOL, LEGACY_CORE_SEMANTIC_PROTOCOL, coreSemanticCaseInput, coreSemanticContract, coreSemanticCorpus, scoreCoreSemanticRun, validateCoreSemanticAssets, verifyCoreSemanticReview } from "./core-semantic";
import { validateQualificationInputPolicy } from "./input-planning";
import { modelWireAdapterIdentity } from "./wire-custody";
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

type QualificationReport = Awaited<ReturnType<typeof runQualification>>;
type CoreSemanticReport = Extract<QualificationReport, { protocol: typeof CORE_SEMANTIC_PROTOCOL }>;
type BaselineReport = Exclude<QualificationReport, CoreSemanticReport>;

function verifyCoreSemanticReceipt(report: CoreSemanticReport, approval: QualificationApproval, registry: WorldRegistry, root?: string): CheckedQualification {
  validateCoreSemanticAssets();
  const policy = validateQualificationInputPolicy(report.input_policy);
  const projectRoot = root ?? resolve(import.meta.dir, "../..");
  if (approval.protocol !== CORE_SEMANTIC_PROTOCOL || report.schema !== "kizuki.world-qualification-run/v3" || report.evidence !== "runner_observed_transport" || report.synthetic !== true ||
      report.source_clean !== true || !/^[a-f0-9]{40}$/.test(report.source_commit) || report.runner_sha256 !== runnerDigest(projectRoot) ||
      report.registry_sha256 !== registryDigest(registry) || report.missing.length !== 0 || !report.model || !report.endpoint_host ||
      canonicalJson(report.corpus) !== canonicalJson(coreSemanticCorpus) || canonicalJson([...report.selected_kinds].sort()) !== canonicalJson(["concept", "situation"]) ||
      report.selected_extensions.length !== 0 || canonicalJson(report.selected_cases) !== canonicalJson(coreSemanticCorpus.cases.map(row => row.id)) ||
      report.resumed_from !== null || report.halt_reason !== null || report.response_gap_ms !== RESPONSE_GAP_MS || report.attempts !== coreSemanticCorpus.cases.length ||
      report.observations.length !== coreSemanticCorpus.cases.length || report.traces.length !== coreSemanticCorpus.cases.length ||
      canonicalJson(report.observations.map(row => row.case_id)) !== canonicalJson(report.selected_cases) || canonicalJson(report.traces.map(row => row.case_id)) !== canonicalJson(report.selected_cases) ||
      report.case_states.some(row => row.status !== "observed") || canonicalJson(report.case_states.map(row => row.case_id)) !== canonicalJson(report.selected_cases))
    throw new Error("core semantic report mismatch");
  const expectedAdapter = modelWireAdapterIdentity(projectRoot);
  const result = scoreCoreSemanticRun(report.observations, registry, { source_commit: report.source_commit, input_policy: policy, traces: report.traces,
    wire_adapter: report.wire_adapter, wire_receipts: report.wire_receipts });
  if (!result.automated_passed || canonicalJson(result) !== canonicalJson(report.core_semantic)) throw new Error("core semantic automated checks failed");
  if (canonicalJson(report.wire_adapter) !== canonicalJson(expectedAdapter)) throw new Error("core semantic wire adapter mismatch");
  let previousCompletion: number | null = null;
  for (const item of coreSemanticCorpus.cases) {
    const observed = report.observations.find(row => row.case_id === item.id), matches = report.traces.filter(row => row.case_id === item.id), trace = matches[0];
    const expectedInput = coreSemanticCaseInput(item, registry, policy), prompt = sha256(extractionV2SystemContent(expectedInput));
    if (!observed || canonicalJson(observed.input) !== canonicalJson(expectedInput) || matches.length !== 1 || !trace || trace.origin !== "observed_v3" || trace.transport !== "ok" ||
        trace.http_status === null || trace.http_status < 200 || trace.http_status >= 300 || trace.prompt_sha256 !== prompt || report.prompt_sha256_by_case[item.id] !== prompt ||
        !/^[a-f0-9]{64}$/.test(trace.request_sha256) || !/^[a-f0-9]{64}$/.test(trace.response_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(trace.model_response_sha256 ?? "") || trace.completed_at === null ||
        !Number.isFinite(Date.parse(trace.started_at)) || !Number.isFinite(Date.parse(trace.completed_at)) || Date.parse(trace.completed_at) < Date.parse(trace.started_at) ||
        (previousCompletion !== null && Date.parse(trace.started_at) - previousCompletion < RESPONSE_GAP_MS)) throw new Error("core semantic transport evidence missing");
    previousCompletion = Date.parse(trace.completed_at);
  }
  if (report.prompt_sha256 !== report.prompt_sha256_by_case[coreSemanticCorpus.cases[0]!.id]) throw new Error("core semantic prompt mismatch");
  const reviewPin = approval.body_review;
  if (!reviewPin || !/^[a-z0-9-]+\.json$/.test(reviewPin.file) || !/^[a-f0-9]{64}$/.test(reviewPin.sha256)) throw new Error("core semantic independent review missing");
  const reviewFd = openSync(join(projectRoot, "scripts/fixtures/world-qualification", reviewPin.file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(reviewFd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error("invalid core semantic review file");
    const reviewBytes = readFileSync(reviewFd, "utf8");
    if (sha256(reviewBytes) !== reviewPin.sha256) throw new Error("core semantic review pin mismatch");
    verifyCoreSemanticReview(approval.sha256, result, JSON.parse(reviewBytes));
  } finally { closeSync(reviewFd); }
  const predicates = [...new Set(coreSemanticContract.cases.flatMap(rule => rule.expectation === "abstain" ? [] : ["world.kind", `${rule.classification.kind.slice(6)}.label`, ...rule.details.map(row => row.predicate)]))];
  const checked = { registry_sha256: report.registry_sha256, report_sha256: approval.sha256, kinds: report.selected_kinds, predicates };
  CHECKED.add(checked);
  return checked;
}

export function verifyQualificationReceipt(bytes: string, approval: QualificationApproval, registry: WorldRegistry, root?: string): CheckedQualification {
  if (!/^[a-f0-9]{64}$/.test(approval.sha256) || sha256(bytes) !== approval.sha256 || !/^[a-f0-9]{64}$/.test(approval.endpoint_evidence)) throw new Error("qualification review pin mismatch");
  const parsed = JSON.parse(bytes) as QualificationReport | { readonly protocol: string };
  if ("protocol" in parsed) {
    if (parsed.protocol === LEGACY_CORE_SEMANTIC_PROTOCOL) throw new Error("obsolete core semantic protocol");
    if (parsed.protocol !== CORE_SEMANTIC_PROTOCOL) throw new Error("unknown qualification protocol");
    return verifyCoreSemanticReceipt(parsed as CoreSemanticReport, approval, registry, root);
  }
  if (approval.protocol !== undefined) throw new Error("qualification approval protocol mismatch");
  const report = parsed as Omit<BaselineReport, "schema"> & { schema: string };
  if (!["kizuki.world-qualification-run/v1", "kizuki.world-qualification-run/v2"].includes(report.schema) || report.evidence !== "runner_observed_transport" || report.synthetic !== true ||
      report.source_clean !== true || !/^[a-f0-9]{40}$/.test(report.source_commit) || report.runner_sha256 !== runnerDigest(root) ||
      report.registry_sha256 !== registryDigest(registry) || report.missing.length !== 0 || !report.model || !report.endpoint_host ||
      canonicalJson(report.corpus) !== canonicalJson(qualificationCorpus)) throw new Error("qualification source or corpus mismatch");
  const score = scoreRun(qualificationCorpus, report.schema === "kizuki.world-qualification-run/v2" ? report.observations.filter(row => report.traces.some(trace => trace.case_id === row.case_id && trace.transport === "ok")) : report.observations);
  if (canonicalJson(score) !== canonicalJson(report.score) || report.selected_kinds.length === 0 || new Set(report.selected_kinds).size !== report.selected_kinds.length ||
      report.selected_kinds.some(kind => !score.kinds.some(row => row.kind === kind && row.status === "passed"))) throw new Error("qualification score failed");
  validateFreshCore();
  const supplemental = scoreSupplementalRun(report.observations.filter(row => report.traces.some(trace => trace.case_id === row.case_id && trace.transport === "ok")));
  if (!supplemental.deterministic_passed || canonicalJson(supplemental) !== canonicalJson(report.supplemental) ||
      report.schema !== "kizuki.world-qualification-run/v2" ||
      canonicalJson([...report.selected_kinds].sort()) !== canonicalJson(["concept", "situation"]) ||
      report.selected_extensions.length !== 0 || report.resumed_from !== null ||
      canonicalJson(report.selected_cases) !== canonicalJson(qualificationCorpus.cases.map(row => row.id)))
    throw new Error("fresh core supplemental or independent body review missing");
  const body = approval.body_review;
  if (!body || !/^[a-z0-9-]+\.json$/.test(body.file) || !/^[a-f0-9]{64}$/.test(body.sha256))
    throw new Error("fresh core independent body review missing");
  const bodyFd = openSync(join(root ?? resolve(import.meta.dir, "../.."), "scripts/fixtures/world-qualification", body.file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(bodyFd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error("invalid body review file");
    const bodyBytes = readFileSync(bodyFd, "utf8");
    const expected = { schema: "kizuki.fresh-core-body-review/v1", independent: true, status: "passed",
      report_sha256: approval.sha256, oracle_sha256: supplemental.oracle_sha256,
      cases: supplemental.cases.map(row => ({ case_id: row.id, ...row.body_review,
        // The automated report stays pending; only the separately reviewed artifact attests a pass.
        status: "passed" })) };
    if (sha256(bodyBytes) !== body.sha256 || canonicalJson(JSON.parse(bodyBytes)) !== canonicalJson(expected))
      throw new Error("fresh core body review mismatch");
  } finally { closeSync(bodyFd); }
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
  if (report.schema === "kizuki.world-qualification-run/v2") {
    if (report.response_gap_ms !== RESPONSE_GAP_MS || report.halt_reason !== null ||
        report.case_states.some(row => row.status !== "observed") || canonicalJson(report.case_states.map(row => row.case_id)) !== canonicalJson(report.selected_cases)) throw new Error("qualification continuation incomplete");
    const inherited = report.resumed_from === null ? null : validateResume(report.resumed_from, report, registry);
    const inheritedIds = new Set(inherited?.observations.map(row => row.case_id) ?? []);
    if (canonicalJson(report.observations.filter(row => inheritedIds.has(row.case_id))) !== canonicalJson(inherited?.observations ?? []) ||
        canonicalJson(report.traces.filter(row => row.origin === "inherited_v1")) !== canonicalJson(inherited?.traces ?? [])) throw new Error("qualification inherited evidence changed");
    let previousCompletion = inherited?.completed ?? null;
    const current = report.traces.filter(row => row.origin === "observed_v2");
    if (current.length + inheritedIds.size !== report.traces.length || report.attempts !== (inherited?.attempts ?? 0) + current.length || report.attempts > 100) throw new Error("qualification attempts mismatch");
    for (const trace of current) {
      if (inheritedIds.has(trace.case_id) || trace.http_status === null || trace.http_status < 200 || trace.http_status >= 300 ||
          (previousCompletion !== null && Date.parse(trace.started_at) - previousCompletion < RESPONSE_GAP_MS)) throw new Error("qualification response pacing violated");
      previousCompletion = Date.parse(trace.completed_at!);
    }
  } else for (let index = 1; index < report.traces.length; index++) if (Date.parse(report.traces[index]!.started_at) - Date.parse(report.traces[index - 1]!.started_at) < 60_000) throw new Error("qualification pacing violated");
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
  if (["concept", "situation"].some(kind => registry.kind(kind)?.offeredToProducer && !allowedKinds.has(kind)))
    throw new Error("fresh core qualification pending");
}
