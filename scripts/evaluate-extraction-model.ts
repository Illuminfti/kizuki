import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../packages/core/src/util/ulid";
import { createModelProducerV2Port } from "../packages/core/src/producer/model-v2";
import { EXTRACTION_V2_SYSTEM_PROMPT } from "../packages/core/src/producer/prompt-v2";
import { worldProduceInput } from "../packages/core/src/serve/extract-v2";
import type { ExtractResponseV2, ProduceResultV2 } from "../packages/core/src/contracts/producer-v2";
import { createOpenAiCompatibleLlmPort } from "../packages/llm/src/openai-compatible";
import { fetchTransport } from "../packages/llm/src/transport";
import type { ChatTransport } from "../packages/llm/src/transport";
import { isLoopbackHost } from "../packages/llm/src/config";
import {
  canonicalJson, corpusDigest, loadCorpus, runnerObservedResponseSet, scoreExtraction, sha256, writeQualityReport,
} from "./evaluate-extraction";
import type { QualityCase, QualityResponse } from "./evaluate-extraction";

/**
 * Scores a real model on the frozen synthetic corpus. The runner makes the calls itself, through the
 * same port and producer the serving host binds, so provenance is observed here and never read from a
 * file. The v1 response-file guard in evaluate-extraction.ts is unchanged.
 */
const CASE_BUDGET = { max_input_tokens: 8_000, max_output_tokens: 8_192 };
const iso = (value: string | null): string | null => {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : value;
};

/** A mention names a fixture subject when its label is that subject's own name in a cited record. */
export function referenceSubject(item: QualityCase, label: string): string {
  const wanted = label.normalize("NFC").trim().toLowerCase();
  for (const record of item.records) for (const who of record.subjects) {
    if (who.subject_id.split(":")[1] === wanted) return who.subject_id;
  }
  return "quality:unresolved";
}

/** A non-literal object is stated by the name it points at, so the scorer sees an unsupported tuple, not a malformed one. */
function objectText(object: ExtractResponseV2["claims"][number]["object"], mentions: ReadonlyMap<string, ExtractResponseV2["mentions"][number]>): string {
  if (object.kind === "literal") return object.value;
  if (object.ref.kind === "mention") return mentions.get(object.ref.id)?.label ?? object.ref.id;
  return object.ref.id;
}

/** The typed response, restated as the scorer's tuple shape. Nothing is repaired or invented. */
export function toScorerShape(item: QualityCase, ids: ReadonlyMap<string, string>, response: ExtractResponseV2): { claims: unknown[] } {
  const mentions = new Map(response.mentions.map((mention) => [mention.id, mention]));
  const local = (eventId: string) => ids.get(eventId) ?? eventId;
  const claims = response.claims.map((claim) => {
    const mention = claim.subject.kind === "mention" ? mentions.get(claim.subject.id) : undefined;
    const cited = new Set([...claim.anchors, ...claim.perspective.anchors].map((anchor) => local(anchor.event_id)));
    return {
      kind: "claim", subject: mention === undefined ? "quality:unresolved" : referenceSubject(item, mention.label),
      predicate: claim.predicate, object: objectText(claim.object, mentions),
      polarity: claim.polarity, body: claim.body, valid_from: iso(claim.valid_from), valid_to: iso(claim.valid_to),
      confidence: claim.confidence, sensitivity: claim.sensitivity, event_ids: [...cited].sort(),
    };
  });
  return { claims };
}

export interface ModelRunOptions {
  base_url: string; model: string; reasoning_effort?: string; temperature?: number; json_mode?: boolean; timeout_ms?: number;
  allow_remote?: boolean; corpus_path?: string;
}

export async function runModelEvaluation(options: ModelRunOptions) {
  const url = new URL(options.base_url);
  const loopback = isLoopbackHost(url.hostname);
  if (!loopback && options.allow_remote !== true) throw new Error("a non-loopback endpoint needs --allow-remote and is limited to the synthetic corpus");
  const corpus = loadCorpus(options.corpus_path ?? join(import.meta.dir, "fixtures/extraction-quality-v1.json"));
  const requestHashes: string[] = [], responseHashes: string[] = [];
  const transport: ChatTransport = async (request) => {
    requestHashes.push(sha256(canonicalJson(request.body)));
    const result = await fetchTransport(request);
    responseHashes.push(sha256(result.ok ? canonicalJson(result.body) : `${result.kind}:${result.status}`));
    return result;
  };
  const config: Record<string, unknown> = { base_url: options.base_url, model: options.model, timeout_ms: options.timeout_ms ?? 600_000, max_retries: 0 };
  if (options.reasoning_effort !== undefined) config.reasoning_effort = options.reasoning_effort;
  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.json_mode === true) config.json_mode = true;
  const context = (values: Record<string, unknown>) => ({ vault_path: "/nonexistent", data_dir: "/nonexistent", config: values,
    secrets: async () => { throw new Error("no secret is used"); }, clock: () => new Date().toISOString(), logger: () => {} });
  const llm = createOpenAiCompatibleLlmPort(context(config) as never, { transport });
  const producer = createModelProducerV2Port(context({ deadline_ms: options.timeout_ms ?? 600_000 }) as never, { llm });
  const responses: QualityResponse[] = [];
  const details: unknown[] = [];
  for (const item of corpus.cases) {
    const ids = new Map(item.records.map((record) => [ulid(), record.id]));
    const events = [...ids.entries()].map(([event_id, recordId]) => ({ event_id, text: item.records.find((record) => record.id === recordId)!.text }));
    const started = performance.now();
    const result: ProduceResultV2 = await producer.produce(worldProduceInput(events as never, [], CASE_BUDGET as never));
    const wall_s = (performance.now() - started) / 1000;
    const usage = { calls: result.usage.calls, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
    if (result.status === "ok") {
      responses.push({ case_id: item.id, status: "ok", response: toScorerShape(item, ids, result.response), usage, dropped: result.dropped?.length ?? 0 });
    } else {
      const status = result.status === "unavailable" ? "unavailable" : "rejected";
      responses.push({ case_id: item.id, status, response: null, usage });
    }
    details.push({ case_id: item.id, status: result.status, reason: "reason" in result ? result.reason : null, wall_s });
  }
  const set = runnerObservedResponseSet({
    corpus_sha256: corpusDigest(corpus), model_reference: `${options.model}@${url.host}`, responses,
    provenance: { runner: "evaluate-extraction-model", endpoint_host: url.host, loopback, model: options.model,
      calls: requestHashes.length, request_sha256: requestHashes, response_sha256: responseHashes },
  });
  const report = scoreExtraction(corpus, set);
  return { ...report, prompt_sha256: createHash("sha256").update(EXTRACTION_V2_SYSTEM_PROMPT).digest("hex"), run_nonce: randomBytes(4).toString("hex"), per_case_wall: details };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    const out = flag("--out"), base = flag("--base-url"), model = flag("--model");
    if (out === undefined || base === undefined || model === undefined) throw new Error("usage: evaluate-extraction-model --base-url URL --model NAME --out NEW_FILE [--reasoning-effort E] [--temperature T] [--json-mode] [--allow-remote]");
    const report = await runModelEvaluation({ base_url: base, model, ...(flag("--reasoning-effort") === undefined ? {} : { reasoning_effort: flag("--reasoning-effort")! }),
      ...(flag("--temperature") === undefined ? {} : { temperature: Number(flag("--temperature")) }), ...(args.includes("--json-mode") ? { json_mode: true } : {}), allow_remote: args.includes("--allow-remote") });
    writeQualityReport(out, report);
    console.log(report.passed ? "model fixture score passed" : "model fixture score failed");
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "evaluation failed");
    process.exitCode = 2;
  }
}
