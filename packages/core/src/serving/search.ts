import type { Database } from "bun:sqlite";
import type { AuditDenial, AuditItem, Grant } from "../agents";
import { canonReadGeneration } from "../canon/write-intent";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import { purgeReadEpoch } from "../derived-holds";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { bareRetrievalId } from "../retrieval/ids";
import { searchAuditCandidates } from "../search/query";
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
import { canonChunk, eligible, excerptOf, loadCanon, pageDecision } from "./canon";
import type { CanonIndex } from "./canon";
import { claimsEpoch } from "./epoch";
import { auditArguments, gateAsync } from "./gate";
import type { Served } from "./gate";
import {
  eventDecision,
  quotedChunk,
} from "./ledger";
import { ServeError } from "./types";
import type { CanonChunk, Envelope, QuotedChunk, ServeContext } from "./types";
import { retrievalCandidates } from "./retrieval";
import { currentQuotedSource } from "./ledger";
import { attachSubjectLabels, canonSubjects, projectSubjectLabels } from "./subject-labels";

const SEARCH_SCOPES = ["canon", "ledger", "all"] as const;

const MAX_QUERY_CHARS = 512;
const MAX_SCOPE_IDS = 16;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** Identity sample kept while paging; matches the serving audit row bound. */
const SEARCH_WITHHELD_CAP = 200;

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
 * Classifies one pass of identities. Each page rechecks live vault evidence
 * and every current source. The scan runs past the served limit so a match
 * withheld further down the rank order is still counted.
 */
function classify(
  db: Database,
  index: CanonIndex,
  grant: Grant,
  hits: Pick<SearchHit, "doc_id" | "scope">[],
  seen: Set<string>,
): Classification {
  const result: Classification = { canon: [], quoted: [], withheld: [] };
  const pageSeen = new Set<string>();

  for (const hit of hits) {
    if (seen.has(hit.doc_id) || pageSeen.has(hit.doc_id)) continue;
    pageSeen.add(hit.doc_id);

    if (hit.scope === "canon") {
      const page = index.byId.get(bareRetrievalId(hit.doc_id));
      // A stale index row is not a denial: the page is simply gone.
      if (page === undefined || !eligible(page)) continue;
      const decision = pageDecision(index, grant, page);
      if (!decision.allow) {
        result.withheld.push({ id: page.id, reason: decision.reason });
        continue;
      }
      seen.add(hit.doc_id);
      result.canon.push(
        canonChunk(index, page, decision, excerptOf(page.body, 600).excerpt, page.body.length > 600),
      );
      continue;
    }

    const quoted = currentQuotedSource(db, bareRetrievalId(hit.doc_id));
    if (quoted === null) continue;
    const decision = eventDecision(grant, quoted, index.sourceContext);
    if (!decision.allow) {
      result.withheld.push({ id: quoted.event_id, reason: decision.reason });
      continue;
    }
    seen.add(hit.doc_id);
    result.quoted.push(quotedChunk(quoted, decision.sensitivity));
  }

  return result;
}

function authorizedCount(result: Classification): number {
  return result.canon.length + result.quoted.length;
}

function absorbClassification(into: Classification, from: Classification): void {
  for (const chunk of from.canon) {
    if (authorizedCount(into) >= MAX_RETRIEVAL_LIMIT) break;
    into.canon.push(chunk);
  }
  for (const chunk of from.quoted) {
    if (authorizedCount(into) >= MAX_RETRIEVAL_LIMIT) break;
    into.quoted.push(chunk);
  }
  const room = SEARCH_WITHHELD_CAP - into.withheld.length;
  if (room > 0) into.withheld.push(...from.withheld.slice(0, room));
}

interface SearchReadSnapshot {
  generation: number;
  sourceEpoch: number;
  purgeEpoch: number;
  memoryEpoch: number;
}

function snapshotSearchRead(ctx: ServeContext, generation: number): SearchReadSnapshot {
  return {
    generation,
    sourceEpoch: sourcePolicyEpoch(ctx.db),
    purgeEpoch: purgeReadEpoch(ctx.db),
    memoryEpoch: claimsEpoch(ctx.db),
  };
}

function assertSearchRead(ctx: ServeContext, snapshot: SearchReadSnapshot): void {
  if (canonReadGeneration(ctx.db) !== snapshot.generation) {
    throw new ServeError("held", "canon changed during request; retry");
  }
  if (purgeReadEpoch(ctx.db) !== snapshot.purgeEpoch) {
    throw new ServeError("held", "canon unavailable during purge recovery");
  }
  if (sourcePolicyEpoch(ctx.db) !== snapshot.sourceEpoch) {
    throw new ServeError("error", "source authorization changed during request; retry");
  }
  if (claimsEpoch(ctx.db) !== snapshot.memoryEpoch) {
    throw new ServeError("error", "memory changed during request; retry");
  }
}

export interface SearchData {
  degraded: string[];
}

export async function serveSearch(
  ctx: ServeContext,
  args: SearchArgs,
): Promise<Envelope<SearchData>> {
  return gateAsync(ctx, "search", auditArguments(args), async ({ ctx, at }): Promise<Served<SearchData>> => {
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

    const base: Omit<SearchOptions, "ceiling"> = {
      scope,
      limit: rows,
      ...(types === undefined ? {} : { types }),
      ...(subjects === undefined ? {} : { subjects }),
      ...window,
    };

    const nominated = await retrievalCandidates(ctx, query, { ...base, ceiling: grant.ceiling });
    // Re-read current canon and evidence only after the engine finishes.
    const index = loadCanon(ctx);
    base.excludePaths = [...index.holds];
    const seen = new Set<string>();
    const narrowed = { ...grant, ...(types === undefined ? {} : { types }), ...(subjects === undefined ? {} : { subjects }), ...(window.since === undefined ? {} : { since: window.since }), ...(window.until === undefined ? {} : { until: window.until }) };
    const classified: Classification = { canon: [], quoted: [], withheld: [] };
    absorbClassification(
      classified,
      classify(
        ctx.db,
        index,
        narrowed,
        nominated.ids.map((doc_id) => ({
          doc_id,
          scope: doc_id.startsWith("page:") ? "canon" : "ledger",
        } as const)),
        seen,
      ),
    );
    // Preserve nomination deduplication, including denied nominations. Ranked
    // pages retain only admitted identities; an arbitrary denied prefix must
    // not accumulate in the cross-page set. Each page has its own bounded set.
    for (const id of nominated.ids) seen.add(id);
    const rankedOpts = {
      ...base,
      limit: MAX_RETRIEVAL_LIMIT,
      source: {
        owner: ctx.principal.kind === "owner",
        purpose: ctx.sourcePurpose ?? "recall",
      },
    };
    const degraded = new Set<string>();
    const read = snapshotSearchRead(ctx, index.generation);
    let offset = 0;
    let previousPage = "";
    // Page the same rank order until MAX_RETRIEVAL_LIMIT authorized hits or the
    // real end. FTS provenance is not an authorization predicate.
    while (true) {
      assertSearchRead(ctx, read);
      const ranked = searchAuditCandidates(ctx.db, query, {
        ...rankedOpts,
        ...(offset === 0 ? {} : { offset }),
      });
      for (const reason of ranked.degraded) degraded.add(reason);
      if (ranked.candidates.length === 0) break;
      const pageKey = ranked.candidates.map((hit) => hit.doc_id).join("\0");
      if (pageKey === previousPage) break;
      previousPage = pageKey;
      absorbClassification(
        classified,
        classify(ctx.db, index, narrowed, ranked.candidates, seen),
      );
      if (
        authorizedCount(classified) >= MAX_RETRIEVAL_LIMIT ||
        ranked.candidates.length < MAX_RETRIEVAL_LIMIT
      ) {
        break;
      }
      offset += ranked.candidates.length;
    }
    const canon = classified.canon.slice(0, rows), quoted = classified.quoted.slice(0, Math.max(0, rows - classified.canon.length));
    const canonicalSubjects = new Map(canon.map(chunk => [chunk.page_id, canonSubjects(index, index.byId.get(chunk.page_id)!)]));
    const projection = projectSubjectLabels(index, narrowed, at, [...canonicalSubjects.values()].flat().concat(quoted.flatMap(chunk => chunk.subjects)), canon.length + quoted.length);
    const audit = new Map<string, AuditItem>();
    for (const chunk of [...canon, ...quoted]) {
      const subjects = "page_id" in chunk ? canonicalSubjects.get(chunk.page_id)! : chunk.subjects;
      for (const item of attachSubjectLabels(projection, chunk, subjects)) audit.set(item.id, item);
    }
    for (const reason of nominated.degraded) degraded.add(reason);
    for (const reason of projection.degraded) degraded.add(reason);

    return {
      canon, quoted, audit_served: [...audit.values()],
      withheld: classified.withheld,
      ...(degraded.size === 0 ? {} : { data: { degraded: [...degraded] } }),
    };
  });
}
