import {
  OWNER,
  PACKET_PURPOSES,
  compareRfc3339,
  isRfc3339,
  serveContextPacket,
} from "@kizuki/core";
import type { PacketPurpose } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

function parseBudget(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("invalid --budget");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 50 || value > 2_000) {
    throw new UsageError("invalid --budget");
  }
  return value;
}

function parseQuery(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Match the context packet's text contract before opening its audited vault.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    throw new UsageError("invalid arguments: query: must not contain control characters");
  }
  if (raw.trim().length === 0) {
    throw new UsageError("invalid arguments: query: must not be blank");
  }
  if (Array.from(raw).length > 512) {
    throw new UsageError("invalid arguments: query: must be at most 512 characters");
  }
  return raw;
}

function parseWindowBound(field: "since" | "until", raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isRfc3339(raw)) {
    throw new UsageError(`invalid arguments: ${field}: must be an RFC3339 timestamp`);
  }
  return raw;
}

function parseContextWindow(options: Map<string, string>): { since?: string; until?: string } {
  const since = parseWindowBound("since", options.get("--since"));
  const until = parseWindowBound("until", options.get("--until"));
  if (since !== undefined && until !== undefined && compareRfc3339(since, "since", until, "until") > 0) {
    throw new UsageError("invalid arguments: since: must not be after until");
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

export const CONTEXT_SCHEMA = {
  options: ["--purpose", "--budget", "--query", "--since", "--until"],
  flags: ["--json"],
  defaults: { "--purpose": "session" },
  bounds: {
    "--purpose": "session|recall|correction|audit",
    "--budget": "50..2000",
    "--since": "RFC3339",
    "--until": "RFC3339",
  },
} as const satisfies CommandHelpSchema;

export const contextCommand: Command = {
  name: "context",
  usage:
    "context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--since RFC3339] [--until RFC3339] [--json]",
  summary: "give your agent relevant context, with sources and a token budget",
  schema: CONTEXT_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...CONTEXT_SCHEMA.options],
      flags: [...CONTEXT_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const rawPurpose = parsed.options.get("--purpose") ?? CONTEXT_SCHEMA.defaults["--purpose"];
    if (!(PACKET_PURPOSES as readonly string[]).includes(rawPurpose)) {
      throw new UsageError(this.usage);
    }
    const rawBudget = parsed.options.get("--budget");
    const budget = rawBudget === undefined ? undefined : parseBudget(rawBudget);
    const query = parseQuery(parsed.options.get("--query"));
    const window = parseContextWindow(parsed.options);

    return withReadVault(io, async (ctx) => {
      const envelope = await serveContextPacket(
        { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }), ...(ctx.retrievalUnavailable ? { retrievalUnavailable: ctx.retrievalUnavailable } : {}) },
        {
          purpose: rawPurpose as PacketPurpose,
          ...(budget === undefined ? {} : { budget_tokens: budget }),
          ...(query === undefined ? {} : { query }),
          ...window,
        },
      );
      ctx.assertCurrent();
      const retrievalDegraded = envelope.data?.retrieval_degraded ?? [];
      if (retrievalDegraded.length > 0) io.err(`degraded=${retrievalDegraded.join(",")}`);
      const incomplete = envelope.data === undefined || envelope.denied.some(
        (entry) => entry.reason === "error",
      );
      if (incomplete) {
        io.err("Context could not be gathered completely. Run kizuki doctor to check the vault.");
      } else if (envelope.data !== undefined && Object.values(envelope.data.sections).every((count) => count === 0)) {
        io.err("No matching context fits this packet. Try a broader --query, a larger --budget, or an explicit --since/--until window; use kizuki doctor to check your sources.");
      }
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("context", incomplete || retrievalDegraded.length > 0 ? "degraded" : "ok", envelope, {
          degraded: incomplete ? ["context-unavailable", ...retrievalDegraded] : retrievalDegraded,
        }));
      } else if (envelope.data !== undefined) {
        io.out(envelope.data.packet_md);
      }
      return incomplete ? 1 : 0;
    }, { audit: true, retrieval: "optional" });
  },
};
