import type { SearchHit } from "@kizuki/core";
import { OWNER, initAgents, retrievalDocId, serveSearch } from "@kizuki/core";
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
  if (!Number.isInteger(value) || value < 1 || value > 50) {
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
  summary: "search current authorized evidence through configured retrieval and the lexical floor",
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

      initAgents(ctx.db);
      const envelope = await serveSearch({
        db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER,
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
      }, { query: text, scope: rawScope as SearchScope, limit });
      const hits: SearchHit[] = [
        ...envelope.canon.map((chunk, index): SearchHit => ({
          doc_id: retrievalDocId("page", chunk.page_id), scope: "canon", title: chunk.title,
          path: chunk.path, page_type: chunk.type, sensitivity: chunk.sensitivity,
          taint: chunk.taint, authority: chunk.authority ?? "owner_authored", occurred_at: "",
          connector_id: "", subjects: chunk.subjects, snippet: chunk.excerpt, rank: index,
        })),
        ...envelope.quoted.map((chunk, index): SearchHit => ({
          doc_id: retrievalDocId("event", chunk.event_id), scope: "ledger", title: `${chunk.connector_id} ${chunk.kind}`,
          path: "", page_type: chunk.kind, sensitivity: chunk.sensitivity,
          taint: "quoted", authority: "connector_evidence", occurred_at: chunk.occurred_at,
          connector_id: chunk.connector_id, subjects: chunk.subjects, snippet: chunk.text, rank: index,
        })),
      ];
      const withheld = envelope.denied.reduce((sum, item) => sum + item.count, 0);
      const degraded = [...new Set([...freshness.degraded, ...(envelope.data?.degraded ?? [])])];
      if (withheld > 0) io.err(`withheld=${withheld} (excluded by access policy)`);
      if (degraded.length > 0) io.err(`degraded=${degraded.join(",")}`);

      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope(
            "query",
            degraded.length === 0 ? "ok" : "degraded",
            { hits, withheld },
            { degraded },
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
