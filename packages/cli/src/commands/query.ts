import type { SearchHit, SearchOptions } from "@kizuki/core";
import { listCanonPages, readHolds, search } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import { indexFreshness } from "../derived";
import { clean, jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

const SCOPES = ["canon", "ledger", "all"] as const;
type SearchScope = (typeof SCOPES)[number];

function parseLimit(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("invalid --limit");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new UsageError("invalid --limit");
  }
  return value;
}

function formatHit(hit: SearchHit): string {
  const snippet = clean(hit.snippet);
  if (hit.scope === "canon") {
    return `page ${hit.doc_id} ${hit.path} ${hit.sensitivity} ${snippet}`;
  }
  return `event ${hit.doc_id} ${hit.connector_id} ${hit.occurred_at} ${snippet}`;
}

export const queryCommand: Command = {
  name: "query",
  usage: "query <text> [--scope canon|ledger|all] [--limit N] [--json] [--degraded]",
  summary: "search labeled canon and ledger text through the FTS floor",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--scope", "--limit"],
      flags: ["--json", "--degraded"],
    });
    const [text] = requirePositional(parsed.positionals, 1);
    if (text === undefined) throw new UsageError(this.usage);

    const rawScope = parsed.options.get("--scope") ?? "all";
    if (!(SCOPES as readonly string[]).includes(rawScope)) {
      throw new UsageError(this.usage);
    }
    const rawLimit = parsed.options.get("--limit");
    const limit = rawLimit === undefined ? 20 : parseLimit(rawLimit);
    const allowDegraded = parsed.flags.has("--degraded");

    return withVault(io, async (ctx) => {
      const freshness = indexFreshness(ctx.db, ctx.vaultPath);
      if (!freshness.fresh && !allowDegraded) {
        io.err(
          `error: search index is stale (${freshness.degraded.join(", ")}); run a sync/import or pass --degraded`,
        );
        return 1;
      }

      let pages;
      try {
        pages = listCanonPages(ctx.vaultPath);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const excludePaths = [
        ...readHolds(ctx.db).map((hold) => hold.page_path),
        ...pages
          .filter((page) => page.data["status"] === "archived")
          .map((page) => page.relPath),
      ];

      const base: SearchOptions = {
        scope: rawScope as SearchScope,
        limit,
        excludePaths,
      };
      const hits = search(ctx.db, text, { ...base, ceiling: "private" });
      const unfiltered = search(ctx.db, text, base);
      const withheld = unfiltered.length - hits.length;
      if (withheld > 0) {
        io.err(`withheld=${withheld} (no sensitivity label)`);
      }
      if (!freshness.fresh) {
        io.err(`degraded=${freshness.degraded.join(",")}`);
      }

      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope(
            "query",
            freshness.fresh ? "ok" : "degraded",
            { hits, withheld },
            { degraded: freshness.degraded },
          ),
        );
        return 0;
      }
      if (hits.length === 0 && withheld === 0) {
        io.err("0 hits");
      }
      for (const hit of hits) io.out(formatHit(hit));
      return 0;
    });
  },
};
