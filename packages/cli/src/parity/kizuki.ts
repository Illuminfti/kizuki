import { cliArgs } from "../runtime";
import { boundedCommand } from "./process";
import type { KizukiAnswer } from "./run";

const DEGRADATIONS = new Set([
  "query-relaxed", "query-no-match", "index-degraded", "context-unavailable", "required_context_overflow",
  "retrieval-unavailable", "retrieval-invalid-response", "retrieval-degraded", "retrieval-source-egress-denied",
  "retrieval-type-scope-unavailable", "retrieval-graph-unavailable", "retrieval-graph-class-scope-unavailable",
  "subject-labels-overflow", "subject-labels-unavailable", "configured-engine-unavailable",
]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const keys = (values: string[]) => values.filter(value => value.length > 0 && value.length <= 1024).slice(0, 32);

/** Only bounded source keys and diagnostic codes cross into the receipt builder.
 * The real public context command owns its ordinary authorization and audit. */
export function contextAnswer(stdout: string): KizukiAnswer {
  try {
    const wire: unknown = JSON.parse(stdout);
    if (!record(wire) || wire.schema !== "kizuki.cli.context/v1" || !record(wire.data)) throw new Error();
    const envelope = wire.data;
    if (!Array.isArray(envelope.denied)) throw new Error();
    if (!record(envelope.data) || envelope.denied.some(item => record(item) && item.reason === "error")) return { ok: false, errorClass: "context_incomplete" };
    if (!Array.isArray(envelope.canon) || !Array.isArray(envelope.quoted) || !strings(envelope.data.retrieval_degraded)) throw new Error();
    const chunks: string[][] = [];
    for (const chunk of envelope.canon) {
      if (!record(chunk) || typeof chunk.path !== "string" || !strings(chunk.sources)) throw new Error();
      chunks.push(keys([chunk.path, ...chunk.sources]));
    }
    for (const chunk of envelope.quoted) {
      if (!record(chunk)) throw new Error();
      if (typeof chunk.event_id === "string") chunks.push(keys([chunk.event_id]));
      else {
        if (typeof chunk.path !== "string" || !strings(chunk.sources)) throw new Error();
        chunks.push(keys([chunk.path, ...chunk.sources]));
      }
    }
    // Retain only known diagnostic vocabulary, never arbitrary child strings.
    const degraded = [...new Set(envelope.data.retrieval_degraded.map(value => DEGRADATIONS.has(value) ? value : "retrieval-degraded"))];
    return { ok: true, chunks, degraded: degraded.slice(0, 8) };
  } catch { return { ok: false, errorClass: "kizuki_error" }; }
}

export async function askKizuki(vault: string, query: string, options: {
  timeoutMs: number;
  signal?: AbortSignal;
  env: Record<string, string | undefined>;
}): Promise<KizukiAnswer> {
  const result = await boundedCommand(cliArgs(["context", "--vault", vault, "--purpose", "recall", "--budget", "2000", `--query=${query}`, "--json"]), options);
  if (result.error === "nonzero_exit" && result.exitCode === 1) {
    const answer = contextAnswer(result.stdout);
    return answer.ok ? { ok: false, errorClass: "kizuki_error" } : answer;
  }
  if (result.error !== undefined) return { ok: false, errorClass: result.error === "timeout" ? "timeout" : result.error === "output_too_large" ? "output_too_large" : "kizuki_error" };
  return contextAnswer(result.stdout);
}
