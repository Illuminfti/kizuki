import type { Database } from "bun:sqlite";
import type { AuditDenial, Grant } from "../agents";
import { search } from "../search/query";
import type { SearchHit, SearchOptions } from "../search/query";
import {
  enumOf,
  idList,
  limit,
  rfc3339,
  scopedSubjects,
  scopedTypes,
  scopedWindow,
  text,
} from "./arguments";
import { canonChunk, eligible, loadCanon, pageDecision } from "./canon";
import type { CanonIndex } from "./canon";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import {
  eventDecision,
  ledgerHitSource,
  liveEventIds,
  quotedChunk,
} from "./ledger";
import type { CanonChunk, Envelope, QuotedChunk, ServeContext } from "./types";

export const SEARCH_SCOPES = ["canon", "ledger", "all"] as const;

const MAX_QUERY_CHARS = 512;
const MAX_SCOPE_IDS = 16;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export interface SearchArgs {
  query: string;
  scope?: (typeof SEARCH_SCOPES)[number];
  limit?: number;
  types?: string[];
  subjects?: string[];
  since?: string;
  until?: string;
}

interface Classification {
  canon: CanonChunk[];
  quoted: QuotedChunk[];
  withheld: AuditDenial[];
}

/**
 * Classifies one pass of hits. `collect` is false for the ceiling-free pass,
 * whose only job is to say how much the ceiling hid: a row that would be
 * served there is already in the served pass or was pushed out by the limit,
 * and either way it is not a denial.
 */
function classify(
  db: Database,
  index: CanonIndex,
  grant: Grant,
  hits: SearchHit[],
  seen: Set<string>,
  collect: boolean,
): Classification {
  const result: Classification = { canon: [], quoted: [], withheld: [] };
  const live = liveEventIds(
    db,
    hits.filter((hit) => hit.scope === "ledger").map((hit) => hit.doc_id),
  );

  for (const hit of hits) {
    if (seen.has(hit.doc_id)) continue;
    seen.add(hit.doc_id);

    if (hit.scope === "canon") {
      const page = index.byId.get(hit.doc_id);
      // A stale index row is not a denial: the page is simply gone.
      if (page === undefined || !eligible(page)) continue;
      const decision = pageDecision(index, grant, page);
      if (!decision.allow) {
        result.withheld.push({ id: page.id, reason: decision.reason });
        continue;
      }
      if (collect) {
        result.canon.push(
          canonChunk(page, decision.sensitivity, hit.snippet, false),
        );
      }
      continue;
    }

    if (!live.has(hit.doc_id)) continue;
    const source = ledgerHitSource(hit);
    const decision = eventDecision(grant, source);
    if (!decision.allow) {
      result.withheld.push({ id: source.event_id, reason: decision.reason });
      continue;
    }
    if (collect) result.quoted.push(quotedChunk(source, decision.sensitivity));
  }

  return result;
}

export function serveSearch(ctx: ServeContext, args: SearchArgs): Envelope {
  return gate(ctx, "search", auditArguments(args), ({ ctx }): Served<undefined> => {
    const grant = ctx.principal.grant;
    const query = text("query", args.query, MAX_QUERY_CHARS);
    const scope =
      args.scope === undefined
        ? "canon"
        : enumOf("scope", args.scope, SEARCH_SCOPES);
    const rows = limit("limit", args.limit, MAX_LIMIT, DEFAULT_LIMIT);
    const types = scopedTypes(
      grant,
      args.types === undefined
        ? undefined
        : idList("types", args.types, MAX_SCOPE_IDS),
    );
    const subjects = scopedSubjects(
      grant,
      args.subjects === undefined
        ? undefined
        : idList("subjects", args.subjects, MAX_SCOPE_IDS),
    );
    const window = scopedWindow(
      grant,
      args.since === undefined ? undefined : rfc3339("since", args.since),
      args.until === undefined ? undefined : rfc3339("until", args.until),
    );

    const index = loadCanon(ctx);
    const base: SearchOptions = {
      scope,
      limit: rows,
      excludePaths: [...index.holds],
      ...(types === undefined ? {} : { types }),
      ...(subjects === undefined ? {} : { subjects }),
      ...window,
    };

    const seen = new Set<string>();
    const served = classify(
      ctx.db,
      index,
      grant,
      search(ctx.db, query, { ...base, ceiling: grant.ceiling }),
      seen,
      true,
    );
    const hidden = classify(
      ctx.db,
      index,
      grant,
      search(ctx.db, query, base),
      seen,
      false,
    );

    return {
      canon: served.canon,
      quoted: served.quoted,
      withheld: [...served.withheld, ...hidden.withheld],
    };
  });
}
