import { OWNER, serveContextPacket } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { jsonEnvelope } from "../output";
import { readQuerySet } from "../parity/queries";
import { writeParityReceipt } from "../parity/receipt";
import { runParity } from "../parity/run";
import type { KizukiAnswer } from "../parity/run";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const DEFAULT_K = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_OVERLAP = 0.5;
const MAX_CHUNK_KEYS = 32;
const MAX_KEY_CHARS = 1024;

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
    "--timeout-ms": "100..120000 per query",
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

    return withReadVault(io, async (ctx) => {
      const serving = {
        db: ctx.db,
        vaultPath: ctx.vaultPath,
        principal: OWNER,
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
        ...(ctx.retrievalUnavailable ? { retrievalUnavailable: ctx.retrievalUnavailable } : {}),
      };
      const retrieve = async (query: string): Promise<KizukiAnswer> => {
        try {
          const envelope = await serveContextPacket(serving, { purpose: "recall", query, budget_tokens: 2_000 });
          ctx.assertCurrent();
          if (envelope.data === undefined || envelope.denied.some((entry) => entry.reason === "error")) {
            return { ok: false, errorClass: "context_incomplete" };
          }
          const keys = (values: string[]): string[] =>
            values.filter((value) => value.length > 0 && value.length <= MAX_KEY_CHARS).slice(0, MAX_CHUNK_KEYS);
          return {
            ok: true,
            degraded: envelope.data.retrieval_degraded.slice(0, 8),
            chunks: [
              ...envelope.canon.map((chunk) => keys([chunk.path, ...chunk.sources])),
              ...envelope.quoted.map((chunk) => keys([chunk.event_id])),
            ],
          };
        } catch {
          return { ok: false, errorClass: "kizuki_error" };
        }
      };

      const receipt = await runParity(config, retrieve);
      const path = writeParityReceipt(ctx.vaultPath, receipt);
      const { summary } = receipt;
      if (summary.kizuki_failures > 0) io.err(`kizuki failed for ${summary.kizuki_failures} of ${summary.queries} queries; see the receipt`);
      if (summary.estate_failures > 0) io.err(`estate command failed for ${summary.estate_failures} of ${summary.queries} queries; see the receipt`);
      if (summary.verdict === "below_threshold") io.err(`parity below threshold: ${summary.mean_overlap} < ${config.minOverlap}`);
      if (summary.verdict === "not_measured") io.err("parity not measured: no query had a comparable stack answer");
      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope("parity", summary.exit_code === 0 ? "ok" : "degraded", { run_id: receipt.run_id, receipt: path, summary }),
        );
      } else {
        io.out(
          `parity run=${receipt.run_id} queries=${summary.queries} compared=${summary.compared} mean_overlap=${summary.mean_overlap ?? "none"} verdict=${summary.verdict} estate_failures=${summary.estate_failures} kizuki_failures=${summary.kizuki_failures} receipt=${path}`,
        );
      }
      return summary.exit_code;
    }, { audit: true, retrieval: "optional" });
  },
};
