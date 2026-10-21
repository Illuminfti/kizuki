import { canonicalJson, sha256 } from "../evaluate-extraction";
import { qualificationCorpus } from "./corpus";
import { caseInput, scoreRun, type Observation } from "./score";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { RESUMABLE_RUNS } from "./approvals";

export interface LegacyTrace { case_id: string; prompt_sha256: string; started_at: string; completed_at: string | null; request_sha256: string; response_sha256: string | null; transport: "pending" | "ok" | "failed" }
export interface Trace extends LegacyTrace { http_status: number | null; origin: "inherited_v1" | "observed_v2" }
export interface ResumeTuple { selected_kinds: readonly string[]; selected_extensions: readonly string[]; model: string | null; endpoint_host: string | null; registry_sha256: string; prompt_sha256_by_case: Record<string, string>; selected_cases: readonly string[] }
export interface ResumePin { sha256: string; source_commit: string; runner_sha256: string }
export interface ResumeEvidence { sha256: string; bytes: string }
interface LegacyRun extends Omit<ResumeTuple, "selected_cases"> {
  schema: string; evidence: string; synthetic: boolean; source_clean: boolean; source_commit: string; runner_sha256: string;
  corpus: typeof qualificationCorpus; observations: Observation[]; traces: LegacyTrace[]; missing: string[]; score: ReturnType<typeof scoreRun>;
}

/** Exact reviewed predecessor bytes, not a response import or a favorable-resampling option. */
export function validateResume(evidence: ResumeEvidence, tuple: ResumeTuple, registry: WorldRegistry, pins: readonly ResumePin[] = RESUMABLE_RUNS) {
  const pin = pins.find(row => row.sha256 === evidence.sha256);
  if (!pin || sha256(evidence.bytes) !== pin.sha256 || evidence.bytes.length > 32 * 1024 * 1024) throw new Error("resume artifact pin mismatch");
  const prior = JSON.parse(evidence.bytes) as LegacyRun;
  if (prior.schema !== "kizuki.world-qualification-run/v1" || prior.evidence !== "runner_observed_transport" || !prior.synthetic || !prior.source_clean ||
      prior.source_commit !== pin.source_commit || prior.runner_sha256 !== pin.runner_sha256 || prior.missing.length !== 0 ||
      canonicalJson(prior.corpus) !== canonicalJson(qualificationCorpus) || canonicalJson(prior.score) !== canonicalJson(scoreRun(qualificationCorpus, prior.observations))) throw new Error("resume provenance mismatch");
  for (const key of ["selected_kinds", "selected_extensions", "model", "endpoint_host", "registry_sha256", "prompt_sha256_by_case"] as const)
    if (canonicalJson(prior[key]) !== canonicalJson(tuple[key])) throw new Error("resume tuple mismatch");
  if (prior.traces.length !== prior.observations.length || prior.traces.length > 100 || new Set(prior.observations.map(row => row.case_id)).size !== prior.observations.length) throw new Error("resume attempts mismatch");
  const observations: Observation[] = [], traces: Trace[] = [], retry: string[] = [];
  let completed = 0;
  for (const observed of prior.observations) {
    const item = qualificationCorpus.cases.find(row => row.id === observed.case_id);
    const matches = prior.traces.filter(row => row.case_id === observed.case_id), trace = matches[0];
    if (!item || !tuple.selected_cases.includes(item.id) || canonicalJson(observed.input) !== canonicalJson(caseInput(item, registry)) || matches.length !== 1 || !trace ||
        trace.prompt_sha256 !== tuple.prompt_sha256_by_case[item.id] || trace.prompt_sha256 !== sha256(extractionV2SystemContent(observed.input)) ||
        trace.completed_at === null || !Number.isFinite(Date.parse(trace.started_at)) || !Number.isFinite(Date.parse(trace.completed_at)) || Date.parse(trace.completed_at) < Date.parse(trace.started_at) ||
        !/^[a-f0-9]{64}$/.test(trace.request_sha256) || !/^[a-f0-9]{64}$/.test(trace.response_sha256 ?? "")) throw new Error("resume trace mismatch");
    completed = Math.max(completed, Date.parse(trace.completed_at));
    if (trace.transport === "failed" && trace.response_sha256 === sha256("http:429") && observed.status === "unavailable" && observed.response === null) retry.push(item.id);
    else if (trace.transport === "ok") {
      // Retain rejected/semantically failing responses too: quality never selects which cases to rerun.
      observations.push(observed); traces.push({ ...trace, http_status: null, origin: "inherited_v1" });
    } else throw new Error("resume requires reviewed refusal classification");
  }
  return { observations, traces, retry, completed, attempts: prior.traces.length };
}
