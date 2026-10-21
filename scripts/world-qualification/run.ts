import { constants, closeSync, fstatSync, ftruncateSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { createModelProducerV2Port } from "../../packages/core/src/producer/model-v2";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { createOpenAiCompatibleLlmPort } from "../../packages/llm/src/openai-compatible";
import { fetchTransport, type ChatTransport } from "../../packages/llm/src/transport";
import { isLoopbackHost } from "../../packages/llm/src/config";
import type { PortContext } from "../../packages/core/src/contracts/ports";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { qualificationCorpus } from "./corpus";
import { candidateRegistry, registryDigest } from "./registry";
import { caseInput, scoreRun, type Observation } from "./score";
import { runnerDigest, sourceProvenance } from "./fingerprint";
import { responsePacer, RESPONSE_GAP_MS } from "./pacing";
import { validateResume, type ResumeEvidence, type Trace } from "./resume";

export interface RunOptions {
  kinds: readonly string[]; base_url?: string; model?: string; token_file?: string;
  allow_remote?: boolean; output?: string; case_ids?: readonly string[];
  extensions?: readonly string[];
  resume_from?: string; resume_sha256?: string; stopped?: () => boolean;
}


/** Header-only credential. Never copy the file path, value or request headers into a receipt. */
function credential(path: string | undefined): string | null {
  if (path === undefined) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("token custody rejected");
    const token = readFileSync(fd, "utf8").trim();
    if (token.length === 0 || /[\r\n\0]/.test(token)) throw new Error("token shape rejected");
    return token;
  } finally { closeSync(fd); }
}

function readResume(path: string, sha256: string): ResumeEvidence {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("resume custody rejected");
    return { sha256, bytes: readFileSync(fd, "utf8") };
  } finally { closeSync(fd); }
}

/** No transport injection or response-file mode: this entry point observes its own real port calls. */
export async function runQualification(options: RunOptions) {
  if (options.kinds.length < 1 || options.kinds.length > 16 || new Set(options.kinds).size !== options.kinds.length) throw new Error("invalid kind selection");
  const existing = options.kinds.filter(kind => WORLD_VOCABULARY_MODULES.some(module => module.kind?.id === kind));
  const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, existing, options.extensions);
  const selected = qualificationCorpus.cases.filter(item => existing.includes(item.kind) && (options.case_ids === undefined || options.case_ids.includes(item.id)));
  if (options.case_ids !== undefined && (new Set(options.case_ids).size !== options.case_ids.length || options.case_ids.some(id => !selected.some(item => item.id === id)))) throw new Error("unknown or unavailable case selection");
  // Missing model/corpus/module is an inspectable not_run result, never an empty successful measurement.
  const missing = options.kinds.flatMap(kind => !existing.includes(kind) ? [`${kind}:module_missing`] : !selected.some(item => item.kind === kind) ? [`${kind}:corpus_missing`] : []);
  for (const item of selected) for (const alternatives of item.required) {
    if (!alternatives.some(row => registry.offered.vocabulary.some(predicate => predicate.predicate === row.predicate) &&
      (row.object.kind !== "vocabulary" || registry.offered.refs.includes(row.object.value)))) {
      const reason = `${item.id}:vocabulary_missing`; if (!missing.includes(reason)) missing.push(reason);
    }
  }
  const observations: Observation[] = [], traces: Trace[] = [];
  const first = selected[0];
  const prompt = first === undefined ? null : sha256(extractionV2SystemContent(caseInput(first, registry)));
  const promptByCase = Object.fromEntries(selected.map(item => [item.id, sha256(extractionV2SystemContent(caseInput(item, registry)))]));
  const tuple = { selected_kinds: options.kinds, selected_extensions: options.extensions ?? [], model: options.model ?? null,
    endpoint_host: options.base_url === undefined ? null : new URL(options.base_url).host, registry_sha256: registryDigest(registry),
    prompt_sha256_by_case: promptByCase, selected_cases: selected.map(item => item.id) };
  if ((options.resume_from === undefined) !== (options.resume_sha256 === undefined)) throw new Error("resume requires exact artifact pin");
  const resumedFrom = options.resume_from === undefined ? null : readResume(options.resume_from, options.resume_sha256!);
  const resumed = resumedFrom === null ? null : validateResume(resumedFrom, tuple, registry);
  if (resumed !== null) { observations.push(...resumed.observations); traces.push(...resumed.traces); }
  let haltReason: "requested_stop" | "transport_refused" | null = null;
  const report = () => ({ schema: "kizuki.world-qualification-run/v2" as const,
    evidence: "runner_observed_transport" as const, synthetic: true, selected_kinds: [...options.kinds], selected_extensions: [...(options.extensions ?? [])],
    model: options.model ?? null, endpoint_host: options.base_url === undefined ? null : new URL(options.base_url).host,
    ...sourceProvenance(),
    runner_sha256: runnerDigest(), registry_sha256: registryDigest(registry), prompt_sha256: prompt, prompt_sha256_by_case: promptByCase,
    corpus: qualificationCorpus, observations, traces, missing, selected_cases: tuple.selected_cases,
    resumed_from: resumedFrom, halt_reason: haltReason, response_gap_ms: RESPONSE_GAP_MS,
    attempts: (resumed?.attempts ?? 0) + traces.filter(row => row.origin === "observed_v2").length,
    case_states: selected.map(item => { const trace = traces.find(row => row.case_id === item.id); return { case_id: item.id,
      status: trace === undefined ? "not_run" : trace.transport === "pending" ? "in_flight" : trace.transport === "failed" ? "transport_failed" : "observed" }; }),
    limitations: ["Typed semantic extraction only; free-text rendering, durable filing and consumer behavior require their separate gates.",
      "Transport observation alone does not establish provider identity. Reviewed endpoint/service evidence must accompany an approved report hash.",
      "This fixed authored split must not be used to tune prompts or select responses; changes require a fresh unseen split."],
    score: scoreRun(qualificationCorpus, observations.filter(row => traces.some(trace => trace.case_id === row.case_id && trace.transport === "ok"))) });
  let fd: number | undefined;
  const save = () => {
    const value = report();
    if (fd !== undefined) { const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"); if (bytes.length > 32 * 1024 * 1024) throw new Error("qualification receipt exceeds bound");
      // Only the descriptor created by this process is written. No path lookup or symlink is followed again.
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (written === 0) throw new Error("qualification receipt write made no progress");
        offset += written;
      }
      ftruncateSync(fd, bytes.length); fsyncSync(fd); }
    return value;
  };
  if (options.output !== undefined) fd = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (options.base_url === undefined || options.model === undefined || missing.length > 0) { if (options.base_url === undefined || options.model === undefined) missing.push("model_unconfigured"); return save(); }
    const url = new URL(options.base_url);
    if ((!isLoopbackHost(url.hostname) && options.allow_remote !== true) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("endpoint rejected");
    if (selected.length > 100) throw new Error("qualification exceeds daily attempt ceiling");
    const token = credential(options.token_file);
    let activeCase = "";
    const pacer = responsePacer({ now: () => performance.now(), sleep: ms => Bun.sleep(ms) },
      resumed === null ? 0 : Math.max(0, resumed.completed + RESPONSE_GAP_MS - Date.now()));
    const transport: ChatTransport = async request => {
      const started_at = new Date().toISOString();
      const first = (request.body as { messages: { role: string; content: string }[] }).messages[0];
      if (first?.role !== "system" || sha256(first.content) !== promptByCase[activeCase]) throw new Error("qualification prompt changed");
      const trace: Trace = { case_id: activeCase, prompt_sha256: promptByCase[activeCase]!, started_at, completed_at: null, request_sha256: sha256(canonicalJson(request.body)), response_sha256: null, transport: "pending", http_status: null, origin: "observed_v2" };
      traces.push(trace); save();
      const response = await fetchTransport(request);
      pacer.completed();
      trace.completed_at = new Date().toISOString();
      trace.http_status = response.status === 0 ? null : response.status;
      trace.response_sha256 = sha256(response.ok ? canonicalJson(response.body) : `${response.kind}:${response.status}`);
      trace.transport = response.ok ? "ok" : "failed";
      save();
      return response;
    };
    const context = (config: Record<string, unknown>): PortContext => ({ config, vault_path: "/nonexistent", data_dir: "/nonexistent",
      secrets: async () => { if (token === null) throw new Error("qualification token unavailable"); return token; }, clock: () => new Date().toISOString(), logger: () => {} });
    const llm = createOpenAiCompatibleLlmPort(context({ base_url: options.base_url, model: options.model, max_retries: 0,
      timeout_ms: 180_000, reasoning_effort: "medium", ...(token === null ? {} : { secret_ref: "env:KIZUKI_QUALIFICATION_TOKEN" }) }), { transport });
    const producer = createModelProducerV2Port(context({ deadline_ms: 180_000 }), { llm });
    try {
      for (const item of selected) {
        if (observations.some(row => row.case_id === item.id)) continue;
        // Installed bridge still enforces its shared cap. Never automatically retry a new refusal.
        if (!await pacer.ready(options.stopped)) { haltReason = "requested_stop"; break; }
        activeCase = item.id;
        const input = caseInput(item, registry), result = await producer.produce(input);
        observations.push({ case_id: item.id, input, status: result.status === "ok" ? "ok" : result.status === "unavailable" ? "unavailable" : "rejected",
          response: result.status === "ok" ? result.response : null, dropped: result.status === "ok" ? result.dropped?.length ?? 0 : 0,
          usage: { calls: result.usage.calls, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } });
        console.error(`qualification ${item.id}: ${result.status}`);
        // Preserve all attempts. A refusal is not silently resampled or replaced with a scripted answer.
        save();
        if (traces.at(-1)?.transport === "failed") { haltReason = "transport_refused"; break; }
      }
      return save();
    } finally { await producer.close(); await llm.close(); }
  } finally { if (fd !== undefined) closeSync(fd); }
}

if (import.meta.main) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const args = process.argv.slice(2), value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
    const kinds = value("--kinds"), output = value("--out");
    const allowed = ["--kinds", "--out", "--base-url", "--model", "--token-file", "--allow-remote", "--cases", "--extensions", "--resume-from", "--resume-sha256"];
    for (let index = 0; index < args.length; index++) { const flag = args[index]!; if (!allowed.includes(flag) || args.indexOf(flag) !== index) throw new Error("invalid arguments"); if (flag !== "--allow-remote" && (args[++index] === undefined || args[index]!.startsWith("--"))) throw new Error("missing argument"); }
    if (kinds === undefined || output === undefined) throw new Error("required arguments missing");
    const result = await runQualification({ kinds: kinds.split(","), output, stopped: () => stopped,
      ...(value("--resume-from") === undefined ? {} : { resume_from: value("--resume-from")! }),
      ...(value("--resume-sha256") === undefined ? {} : { resume_sha256: value("--resume-sha256")! }),
      ...(value("--base-url") === undefined ? {} : { base_url: value("--base-url")! }), ...(value("--model") === undefined ? {} : { model: value("--model")! }),
      ...(value("--token-file") === undefined ? {} : { token_file: value("--token-file")! }), ...(value("--cases") === undefined ? {} : { case_ids: value("--cases")!.split(",") }),
      ...(value("--extensions") === undefined ? {} : { extensions: value("--extensions")!.split(",") }), allow_remote: args.includes("--allow-remote") });
    console.log(JSON.stringify({ status: result.score.status, kinds: result.score.kinds.map(({ kind, status }) => ({ kind, status })), missing: result.missing, prompt_sha256: result.prompt_sha256 }));
    process.exitCode = result.selected_kinds.every(kind => result.score.kinds.some(row => row.kind === kind && row.status === "passed")) ? 0 : 1;
  } catch { console.error("qualification failed; no kind was enabled (check arguments, endpoint, credential custody and output path)"); process.exitCode = 2; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
