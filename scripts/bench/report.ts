
export const SIZES = { S: 1_000, M: 20_000, L: 200_000, XL: 1_000_000 } as const;
export type Size = keyof typeof SIZES;
export const READS = ["search", "context_session", "context_query", "get_page", "timeline", "world_discovery", "graph_neighbors"] as const;
export type Read = typeof READS[number];
export const METRICS = [
  "ingest.events_per_s", "canon.writes_per_s", "canon.cpu_ms_per_write",
  ...READS.map(read => `mcp.${read}.wall_ms`),
  ...READS.map(read => `cold_mcp.${read}.wall_ms`),
  ...["search", "context_session", "context_query", "world_discovery"].map(read => `cold_cli.${read}.wall_ms`),
  "doctor.wall_ms", "doctor.peak_rss_bytes", "export.wall_ms", "restore.wall_ms",
  "purge.wall_ms", "rebuild.wall_ms", "daemon.drain_wall_ms", "daemon.drain_peak_rss_bytes", "serve.idle_cpu_percent",
];
export interface Metric {
  unit: "ms" | "bytes" | "events/s" | "writes/s" | "CPU %";
  direction: "lower" | "higher";
  status: "measured" | "omitted";
  samples: number[];
  p50: number | null;
  p95: number | null;
  p99: number | null;
  reason: "smoke skips the 60-second idle observation" | null;
}
export interface Report {
  schema: "kizuki.benchmark/v1";
  profile: "full" | "smoke";
  machine: { cpu_count: number; load_at_start: number[]; bun_version: string; git_sha: string; platform: string; arch: string };
  corpus: { size: Size; seed: number; events: number; max_events_per_topic: 256; topics: number; canon_pages: number; unwritten_claims: number; unextracted_events: number; input_sha256: string };
  protocol: { build_warmup: number; build_repetitions: number; read_warmup: number; read_repetitions: number; process_warmup: number; process_repetitions: number; idle_observed_ms: number; retrieval: "lexical floor"; principal: "owner" };
  metrics: Record<string, Metric>;
}

// The structural schema is also emitted with each report. Validation below walks this same grammar.
type Grammar = { type?: "object" | "array" | "number" | "integer" | "string" | "null"; properties?: Record<string, Grammar>; items?: Grammar; enum?: readonly unknown[]; const?: unknown; minimum?: number; maximum?: number; pattern?: string; minItems?: number; maxItems?: number; anyOf?: Grammar[] };
const number: Grammar = { type: "number", minimum: 0 };
const integer: Grammar = { type: "integer", minimum: 0 };
const positive: Grammar = { type: "integer", minimum: 1 };
const nullable = (grammar: Grammar): Grammar => ({ anyOf: [grammar, { type: "null" }] });
const object = (properties: Record<string, Grammar>): Grammar => ({ type: "object", properties });
const metricGrammar = object({
  unit: { enum: ["ms", "bytes", "events/s", "writes/s", "CPU %"] }, direction: { enum: ["lower", "higher"] },
  status: { enum: ["measured", "omitted"] }, samples: { type: "array", items: number },
  p50: nullable(number), p95: nullable(number), p99: nullable(number), reason: nullable({ const: "smoke skips the 60-second idle observation" }),
});
const grammar = object({
  schema: { const: "kizuki.benchmark/v1" }, profile: { enum: ["full", "smoke"] },
  machine: object({ cpu_count: positive, load_at_start: { type: "array", items: number, minItems: 3, maxItems: 3 }, bun_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" }, git_sha: { type: "string", pattern: "^[0-9a-f]{40}$" }, platform: { enum: ["linux", "darwin", "win32"] }, arch: { type: "string", pattern: "^[a-z0-9]+$" } }),
  corpus: object({ size: { enum: Object.keys(SIZES) }, seed: { ...integer, maximum: 0xffffffff }, events: positive, max_events_per_topic: { const: 256 }, topics: positive, canon_pages: positive, unwritten_claims: integer, unextracted_events: integer, input_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }),
  protocol: object({ build_warmup: integer, build_repetitions: positive, read_warmup: integer, read_repetitions: positive, process_warmup: integer, process_repetitions: positive, idle_observed_ms: number, retrieval: { const: "lexical floor" }, principal: { const: "owner" } }),
  metrics: object(Object.fromEntries(METRICS.map(name => [name, metricGrammar]))),
});
function structural(value: unknown, rule: Grammar): boolean {
  if (rule.anyOf) return rule.anyOf.some(alternative => structural(value, alternative));
  if (Object.hasOwn(rule, "const") && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  switch (rule.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>, properties = rule.properties!;
      return Object.keys(record).sort().join() === Object.keys(properties).sort().join() && Object.entries(properties).every(([key, field]) => structural(record[key], field));
    }
    case "array": return Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? Infinity) && value.every(item => structural(item, rule.items!));
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && (rule.type !== "integer" || Number.isInteger(value)) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
    case "string": return typeof value === "string" && (rule.pattern === undefined || new RegExp(rule.pattern).test(value));
    case "null": return value === null;
    default: return true;
  }
}
function jsonGrammar(rule: Grammar): Record<string, unknown> {
  if (rule.type === "object") return { ...rule, additionalProperties: false, required: Object.keys(rule.properties!), properties: Object.fromEntries(Object.entries(rule.properties!).map(([key, field]) => [key, jsonGrammar(field)])) };
  if (rule.type === "array") return { ...rule, items: jsonGrammar(rule.items!) };
  if (rule.anyOf) return { anyOf: rule.anyOf.map(jsonGrammar) };
  return { ...rule };
}
export const reportJsonSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", ...jsonGrammar(grammar) };
export function parseReport(value: unknown): Report {
  if (!structural(value, grammar)) throw new Error("invalid benchmark report structure");
  const report = value as Report;
  const reject = (): never => { throw new Error("invalid benchmark report semantics"); };
  const { corpus, protocol } = report;
  if (corpus.events !== SIZES[corpus.size] || corpus.topics !== Math.ceil(corpus.events / 256) || corpus.canon_pages !== 2 * corpus.topics || corpus.unwritten_claims !== corpus.events - corpus.topics) reject();
  if (corpus.unextracted_events >= corpus.events || corpus.unextracted_events > corpus.events - corpus.topics) reject();
  if (report.profile === "full" && (protocol.build_warmup < 1 || protocol.build_repetitions < 2 || protocol.read_warmup < 1 || protocol.read_repetitions < 2 || protocol.process_warmup < 1 || protocol.process_repetitions < 2)) reject();
  for (const [name, metric] of Object.entries(report.metrics)) {
    const unit = name.endsWith("rss_bytes") ? "bytes" : name.endsWith("events_per_s") ? "events/s" : name.endsWith("writes_per_s") ? "writes/s" : name.endsWith("cpu_percent") ? "CPU %" : "ms";
    if (metric.unit !== unit || metric.direction !== (unit.endsWith("/s") ? "higher" : "lower")) reject();
    if (metric.status === "measured") {
      if (metric.samples.length === 0 || metric.reason !== null || metric.p50 !== percentile(metric.samples, .5) || metric.p95 !== percentile(metric.samples, .95) || metric.p99 !== percentile(metric.samples, .99)) reject();
      const expected = name.startsWith("cold_") ? protocol.process_repetitions : name.startsWith("mcp.") ? protocol.read_repetitions : name === "serve.idle_cpu_percent" ? 1 : protocol.build_repetitions;
      if (metric.samples.length !== expected) reject();
    } else if (report.profile !== "smoke" || name !== "serve.idle_cpu_percent" || metric.samples.length !== 0 || metric.p50 !== null || metric.p95 !== null || metric.p99 !== null || metric.reason === null) reject();
  }
  if ((report.profile === "full" && protocol.idle_observed_ms < 60_000) || (report.profile === "smoke" && (corpus.size !== "S" || protocol.idle_observed_ms !== 0 || report.metrics["serve.idle_cpu_percent"]?.status !== "omitted"))) reject();
  return report;
}

/** Nearest-rank percentiles; small samples deliberately expose their limited resolution. */
export function percentile(samples: readonly number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}
export function distribution(unit: Metric["unit"], samples: number[], direction: Metric["direction"] = "lower"): Metric {
  return { unit, direction, status: "measured", samples, p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), reason: null };
}
export function summary(report: Report): string {
  const rows = Object.entries(report.metrics).map(([name, metric]) => `| ${name} | ${metric.unit} | ${metric.samples.length} | ${format(metric.p50)} | ${format(metric.p95)} | ${format(metric.p99)} | ${metric.status === "measured" && metric.unit !== "bytes" ? format(metric.p50! * (metric.direction === "higher" ? 10 : .1)) : "—"} |`);
  return `# Synthetic scale benchmark\n\nSchema: ${report.schema}; profile: ${report.profile}.\n\nCPU count: ${report.machine.cpu_count}; load at start: ${report.machine.load_at_start.join(", ")}; Bun: ${report.machine.bun_version}; platform: ${report.machine.platform}/${report.machine.arch}; git: ${report.machine.git_sha}.\n\n${report.corpus.size}: ${report.corpus.events} events, ${report.corpus.canon_pages} canon pages, seed ${report.corpus.seed}; input SHA-256: ${report.corpus.input_sha256}.\n\n| Metric | Unit | Samples | p50 | p95 | p99 | 10x p50 target |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nCold means a fresh runtime, not a flushed operating-system cache. CPU per write is amortized over real write passes. RSS is the child process high-water mark, including startup. The smoke profile omits idle CPU; full runs observe at least 60 seconds after daemon startup. Synthetic repetitions measure execution cost, not model quality or provider latency.\n`;
}
function format(value: number | null): string { return value === null ? "—" : value.toFixed(3); }
