import { baselineReadState, baselineReadUnchanged } from "./read-state";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import { OWNER, serveContextPacket, serveSearch, serveTimeline } from "../../../packages/core/src/index";
import { PACKET_TOKENIZER_ID, packetPrefix, packetTokens } from "../../../packages/core/src/serving/packet-tokenizer";
import { AS_OF, persona } from "./persona";
import { assertLogicalClock } from "./clock";
import { generateVault } from "./vault";
import { runEvaluationWorker } from "./run";

export const BASELINE_ARMS = ["raw_history", "lexical", "current_kizuki"] as const;
export const BASELINE_SCHEDULE = ["before_correction", "after_correction", "after_source_revoke"] as const;
const ROOT = join(import.meta.dir, "../../..");
const BUDGET = 2000;
const QUERY = "Orchard";
const OLD = "waiting for the paint samples", NEW = "waiting for the load test";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const LIMITS = ["retrieval_only", "scripted_fixture_not_model_quality", "historical_exposure_not_false_current", "no_human_or_competitor_trial"] as const;
const CONFIG = { arms: BASELINE_ARMS, budget: BUDGET, tokenizer: PACKET_TOKENIZER_ID, model: "none",
  fixture_producer: "scripted-persona-v1", principals: ["owner", "scoped_agent"], query_hash: hash(QUERY),
  projection: "source-text-prefix/v1", read_state: "authoritative-plus-scoped-reference-integrity/v2", scope_sha256: hash("persona:orchard"), timeline_limit: 200, search_limit: 20 } as const;

/** The files actually read by this checkout, including uncommitted harness files.
 * No path or source body is persisted. A dirty result remains labelled dirty. */
export function baselineSource() {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", ROOT, ...args], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) throw new Error("baseline source identity unavailable");
    return result.stdout.toString();
  };
  const files = [...new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"))]
    .filter(file => file && (file.startsWith("packages/") || file.startsWith("scripts/eval/fresh-agent/") || ["bun.lock", "package.json", "tsconfig.json"].includes(file)))
    .filter(file => !file.includes("/node_modules/") && lstatSync(join(ROOT, file)).isFile()).sort();
  const changed = new Set([...git("diff", "--name-only", "HEAD").trim().split("\n"), ...git("ls-files", "--others", "--exclude-standard").trim().split("\n")]);
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(file + "\0").update(hash(readFileSync(join(ROOT, file))) + "\n");
  return { commit: git("rev-parse", "HEAD").trim(), tree: git("rev-parse", "HEAD^{tree}").trim(),
    source_sha256: aggregate.digest("hex"), files: files.length, dirty: files.some(file => changed.has(file)) };
}

type Fixture = Awaited<ReturnType<typeof generateVault>>;

export interface BaselineRow {
  stage: typeof BASELINE_SCHEDULE[number]; arm: typeof BASELINE_ARMS[number]; principal: "owner" | "scoped_agent";
  status: "ok" | "unavailable" | "error"; output_sha256: string; tokens: number; truncated: boolean;
  expected: number; recalled: number; old_exposure: number; forbidden: number; future: number; state_unchanged: boolean;
}

export async function evaluateBaselinesAtLogicalTime(options: { out: string; workspace?: string }) {
  assertLogicalClock();
  const source = baselineSource();
  mkdirSync(options.out, { recursive: false, mode: 0o700 });
  const sandbox = options.workspace ?? mkdtempSync(join(options.out, ".scenario-"));
  let f: Fixture | undefined;
  const rows: BaselineRow[] = [];
  try {
    f = await generateVault(sandbox, "small", { baseline: true });
    for (const stage of BASELINE_SCHEDULE) {
      if (stage === "after_correction") await f.applyCorrection();
      if (stage === "after_source_revoke") f.revokeSharedSource();
      for (const principal of CONFIG.principals) for (const arm of BASELINE_ARMS) {
        const ctx = { db: f.db, vaultPath: f.vaultPath, principal: principal === "owner" ? OWNER : f.principal };
        const before = baselineReadState(ctx);
        let text = "", status: BaselineRow["status"] = "ok";
        try {
          if (arm === "raw_history") {
            const result = serveTimeline(ctx, { subject: "persona:orchard", limit: 200 });
            text = result.quoted.map(row => row.text).join("\n");
          } else if (arm === "lexical") {
            const result = await serveSearch(ctx, { query: QUERY, scope: "all", limit: 20 });
            text = [...result.canon.map(row => row.excerpt), ...result.quoted.map(row => row.text)].join("\n");
          } else {
            const result = await serveContextPacket(ctx, { query: QUERY, purpose: "recall", budget_tokens: BUDGET });
            text = result.data?.packet_md ?? "";
            if (!result.data || result.data.retrieval_degraded.includes("context-unavailable")) status = "unavailable";
          }
        } catch { status = "error"; }
        const limited = packetPrefix(text, BUDGET);
        const expectedValue = stage === "before_correction" ? OLD : principal === "owner" ? NEW : null;
        // A correction's private native assertion is not declassified for a comparison.
        const forbidden = [...f.facts.filter(fact => fact.access === "withheld" || principal === "scoped_agent" && fact.access === "owner_only").map(fact => fact.value),
          ...(stage === "after_source_revoke" ? [OLD, "restore the orchard footbridge"] : [])];
        rows.push({ stage, arm, principal, status, output_sha256: hash(limited), tokens: packetTokens(limited), truncated: limited !== text,
          expected: expectedValue === null ? 0 : 1, recalled: expectedValue !== null && limited.includes(expectedValue) ? 1 : 0,
          old_exposure: stage === "before_correction" ? 0 : Number(limited.includes(OLD)),
          forbidden: new Set(forbidden.filter(value => limited.includes(value))).size,
          future: stage === "before_correction" ? Number(limited.includes(NEW)) : 0, state_unchanged: baselineReadUnchanged(before, ctx) });
      }
    }
    if (JSON.stringify(baselineSource()) !== JSON.stringify(source)) throw new Error("baseline source changed during evaluation");
    const report = { schema: "kizuki.quality-baselines/v1" as const, source, corpus_sha256: digest(persona("small")),
      config_sha256: digest(CONFIG), schedule_sha256: digest({ as_of: AS_OF, stages: BASELINE_SCHEDULE, correction: hash(NEW) }),
      protocol: CONFIG, bun: Bun.version, platform: process.platform, arch: process.arch,
      hardware: { cpu_model_sha256: hash(cpus()[0]?.model ?? "unknown"), logical_cpus: cpus().length, memory_bytes: totalmem() }, rows,
      summary: summarizeBaselines(rows),
      limits: LIMITS };
    writeFileSync(join(options.out, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally { f?.db.close(); rmSync(sandbox, { recursive: true, force: true }); }
}

export type BaselineReport = Awaited<ReturnType<typeof evaluateBaselinesAtLogicalTime>>;
export async function runBaselineEvaluation(options: { out?: string } = {}): Promise<BaselineReport> {
  return await runEvaluationWorker({ ...options, mode: "baselines" }) as BaselineReport;
}

/** Closed and bounded external receipts: compare never copies arbitrary source
 * metadata or private fragments from a caller-provided file into its output. */
export function parseBaselineReceipt(value: unknown): BaselineReport {
  const fail = (): never => { throw new Error("incompatible quality baseline receipt"); };
  const obj = (v: unknown, names: string[]): Record<string, unknown> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail();
    const r = v as Record<string, unknown>;
    if (Object.keys(r).sort().join("|") !== [...names].sort().join("|")) return fail();
    return r;
  };
  const integer = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
  const sha = (v: unknown, length = 64) => typeof v === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(v);
  const r = obj(value, ["schema", "source", "corpus_sha256", "config_sha256", "schedule_sha256", "protocol", "bun", "platform", "arch", "hardware", "rows", "summary", "limits"]);
  const source = obj(r.source, ["commit", "tree", "source_sha256", "files", "dirty"]);
  const hardware = obj(r.hardware, ["cpu_model_sha256", "logical_cpus", "memory_bytes"]);
  if (r.schema !== "kizuki.quality-baselines/v1" || !sha(source.commit, 40) || !sha(source.tree, 40) || !sha(source.source_sha256) ||
      !integer(source.files, 1, 100000) || typeof source.dirty !== "boolean" || !sha(r.corpus_sha256) || !sha(r.schedule_sha256) ||
      r.config_sha256 !== digest(CONFIG) || digest(r.protocol) !== digest(CONFIG) || digest(r.limits) !== digest(LIMITS) ||
      typeof r.bun !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(r.bun) ||
      !["linux", "darwin", "win32"].includes(r.platform as string) || !["x64", "arm64"].includes(r.arch as string) ||
      !sha(hardware.cpu_model_sha256) || !integer(hardware.logical_cpus, 1, 100000) || !integer(hardware.memory_bytes, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(r.rows) || r.rows.length !== 18) return fail();
  let index = 0;
  for (const stage of BASELINE_SCHEDULE) for (const principal of CONFIG.principals) for (const arm of BASELINE_ARMS) {
    const row = obj(r.rows[index++], ["stage", "arm", "principal", "status", "output_sha256", "tokens", "truncated", "expected", "recalled", "old_exposure", "forbidden", "future", "state_unchanged"]);
    if (row.stage !== stage || row.principal !== principal || row.arm !== arm || !["ok", "unavailable", "error"].includes(row.status as string) ||
        !sha(row.output_sha256) || !integer(row.tokens, 0, BUDGET) || typeof row.truncated !== "boolean" || typeof row.state_unchanged !== "boolean" ||
        row.expected !== (stage === "before_correction" || principal === "owner" ? 1 : 0) ||
        !integer(row.recalled, 0, row.expected as number) || !integer(row.old_exposure, 0, 1) ||
        !integer(row.forbidden, 0, 1000) || !integer(row.future, 0, 1)) return fail();
  }
  obj(r.summary, ["observations", "failures", "hard_failures", "expected", "recalled"]);
  const report = value as BaselineReport;
  if (digest(report.summary) !== digest(summarizeBaselines(report.rows))) return fail();
  return report;
}

export function summarizeBaselines(rows: BaselineRow[]) {
  return { observations: rows.length, failures: rows.filter(row => row.status !== "ok").length,
    hard_failures: rows.filter(row => row.forbidden > 0 || row.future > 0 || !row.state_unchanged).length,
    expected: rows.reduce((n,row)=>n+row.expected,0), recalled: rows.reduce((n,row)=>n+row.recalled,0) };
}

export function compareBaselines(referenceInput: unknown, candidateInput: unknown) {
  const reference = parseBaselineReceipt(referenceInput), candidate = parseBaselineReceipt(candidateInput);
  if (reference.source.dirty || candidate.source.dirty || reference.corpus_sha256 !== candidate.corpus_sha256 ||
      reference.config_sha256 !== candidate.config_sha256 || reference.schedule_sha256 !== candidate.schedule_sha256)
    throw new Error("incompatible quality baseline receipts");
  return { schema: "kizuki.quality-baseline-comparison/v1", reference_sha256: digest(reference), candidate_sha256: digest(candidate),
    reference_commit: reference.source.commit, candidate_commit: candidate.source.commit,
    rows: candidate.rows.map((row,i) => ({ stage: row.stage, arm: row.arm, principal: row.principal,
      recall_delta: row.recalled - reference.rows[i]!.recalled, token_delta: row.tokens - reference.rows[i]!.tokens,
      reference_status: reference.rows[i]!.status, status: row.status, hard_failure: row.forbidden > 0 || row.future > 0 || !row.state_unchanged })) };
}

function loadReceipt(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("invalid baseline receipt file");
    const bytes = Buffer.alloc(65537);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > 65536) throw new Error("invalid baseline receipt file");
    return parseBaselineReceipt(JSON.parse(bytes.subarray(0, used).toString("utf8")));
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const run = args.length === 2 && args[0] === "--out";
  const compare = args.length === 3 && args[0] === "--compare";
  if ((!run && !compare) || args.slice(1).some(value => !value || value.startsWith("--"))) {
    console.error("Usage: bun scripts/eval/fresh-agent/baselines.ts --out NEW_DIRECTORY | --compare REFERENCE_JSON CANDIDATE_JSON"); process.exitCode = 2;
  } else try {
    if (compare) {
      const reference = loadReceipt(args[1]!), candidate = loadReceipt(args[2]!);
      console.log(JSON.stringify(compareBaselines(reference, candidate)));
      process.exitCode = candidate.summary.hard_failures || candidate.summary.failures ? 1 : 0;
    } else {
      const report = await runBaselineEvaluation({ out: args[1]! });
      console.log(JSON.stringify(report.summary));
      process.exitCode = report.summary.hard_failures || report.summary.failures ? 1 : 0;
    }
  } catch { console.error("Quality baseline evaluation failed."); process.exitCode = 1; }
}
