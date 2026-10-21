import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { jsonEnvelope } from "../output";
import { readQuerySet } from "../parity/queries";
import { writeParityReceipt } from "../parity/receipt";
import { runParity } from "../parity/run";
import { askKizuki } from "../parity/kizuki";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const DEFAULT_K = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_OVERLAP = 0.5;

function integerOption(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new UsageError(`invalid ${name}`);
  return value;
}

function overlapOption(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MIN_OVERLAP;
  const value = /^(?:[01](?:\.[0-9]{1,4})?|\.[0-9]{1,4})$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= 0 && value <= 1)) throw new UsageError("invalid --min-overlap");
  return value;
}

export const PARITY_SCHEMA = {
  options: ["--queries", "--k", "--timeout-ms", "--min-overlap", "--estate-cmd"],
  flags: ["--json"],
  defaults: { "--k": String(DEFAULT_K), "--timeout-ms": String(DEFAULT_TIMEOUT_MS), "--min-overlap": String(DEFAULT_MIN_OVERLAP) },
  bounds: {
    "--queries": "FILE, one query per line, at most 200",
    "--k": "1..20",
    "--timeout-ms": "100..120000 per side per query",
    "--min-overlap": "0..1",
    "--estate-cmd": "ARGV..., last option; {query} is replaced, else the query is the last argument",
  },
} as const satisfies CommandHelpSchema;

/** Exit codes: 0 parity met, 1 Kizuki-side failure, 2 usage, 3 external command failure, 4 parity below threshold or not measured. */
export const parityCommand: Command = {
  name: "parity",
  usage:
    "parity run --queries FILE [--k 1..20] [--timeout-ms N] [--min-overlap 0..1] [--json] --estate-cmd [--] ARGV...",
  summary: "compare Kizuki context with an existing memory stack and record only hashed, bounded diffs",
  schema: PARITY_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    if (args[0] !== "run") throw new UsageError(this.usage);
    const split = args.indexOf("--estate-cmd");
    if (split < 0) throw new UsageError("missing option --estate-cmd");
    const estate = args.slice(split + 1);
    if (estate[0] === "--") estate.shift();
    if (estate.length === 0) throw new UsageError("missing value for --estate-cmd");

    const parsed = parseArguments(args.slice(1, split), {
      options: PARITY_SCHEMA.options.filter((name) => name !== "--estate-cmd"),
      flags: [...PARITY_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const queriesPath = parsed.options.get("--queries");
    if (queriesPath === undefined) throw new UsageError("missing option --queries");
    const config = {
      k: integerOption("--k", parsed.options.get("--k"), DEFAULT_K, 1, 20),
      timeoutMs: integerOption("--timeout-ms", parsed.options.get("--timeout-ms"), DEFAULT_TIMEOUT_MS, 100, 120_000),
      minOverlap: overlapOption(parsed.options.get("--min-overlap")),
      estate,
      queries: readQuerySet(queriesPath),
    };

    const cancellation = new AbortController();
    let interrupted = 0;
    const interrupt = () => { interrupted = 130; cancellation.abort(); };
    const terminate = () => { interrupted = 143; cancellation.abort(); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
      return await withReadVault(io, async (ctx) => {
        const retrieve = async (query: string) => {
          ctx.assertCurrent();
          const answer = await askKizuki(ctx.vaultPath, query, { timeoutMs: config.timeoutMs, env: io.env, signal: cancellation.signal });
          ctx.assertCurrent();
          return answer;
        };
        const receipt = await runParity({ ...config, signal: cancellation.signal }, retrieve);
        const path = writeParityReceipt(ctx.vaultPath, receipt);
        const { summary } = receipt;
        if (summary.kizuki_failures > 0) io.err(`kizuki failed for ${summary.kizuki_failures} of ${summary.queries} queries; see the receipt`);
        if (summary.estate_failures > 0) io.err(`estate command failed for ${summary.estate_failures} of ${summary.queries} queries; see the receipt`);
        if (summary.verdict === "below_threshold") io.err(`parity below threshold: ${summary.mean_overlap} < ${config.minOverlap}`);
        if (summary.verdict === "not_measured") {
          io.err(`parity not measured: ${summary.compared} of ${summary.queries} queries were comparable (need at least half)`);
        }
        if (parsed.flags.has("--json")) {
          io.out(
            jsonEnvelope("parity", summary.exit_code === 0 ? "ok" : "degraded", { run_id: receipt.run_id, receipt: path, summary }),
          );
        } else {
          io.out(
            `parity run=${receipt.run_id} queries=${summary.queries} compared=${summary.compared} estate_empty=${summary.estate_empty} mean_overlap=${summary.mean_overlap ?? "none"} verdict=${summary.verdict} estate_failures=${summary.estate_failures} kizuki_failures=${summary.kizuki_failures} receipt=${path}`,
          );
        }
        return summary.exit_code;
      }, { retrieval: "none" });
    } catch (error) {
      if (!cancellation.signal.aborted) throw error;
      io.err("parity interrupted");
      return interrupted;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  },
};
