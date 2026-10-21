import { currentSemanticNomination, type RetrievalDomain } from "./retrieval-domain";
import { normalizeReadArgs, type SearchArgsV2 } from "./v2/read-input";
import { createRedactor } from "./redact";
import { searchableText, servedTextMatcher } from "./search-match";
import type { Database } from "bun:sqlite";
import { denyClassesOf } from "../agents";
import { visibleIndexDegraded, visibleLedgerIndexMissing } from "./index-health";
import { authorize } from "../agents";
import type { AuditDenial, AuditItem, Grant } from "../agents";
import { canonReadGeneration } from "../canon/write-intent";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import { purgeReadEpoch } from "../derived-holds";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { requireCeiling } from "../query/sql";
import { isCurrentVersion } from "../search/versions";
import { bareRetrievalId } from "../retrieval/ids";
import { NO_MATCH_LABEL, RELAXED_LABEL, searchAuditCandidates } from "../search/query";
import type { SearchHit, SearchOptions } from "../search/query";
import {
  enumOf,
  flag,
  idList,
  limit,
  rfc3339,
  scopedSubjects,
  scopedTypes,
  scopedWindow,
  text,
} from "./arguments";
import { canonChunk, eligible, excerptOf, loadCanon, pageDecision, pageScope } from "./canon";
import type { CanonIndex } from "./canon";
import { eventsCitedByPages } from "./dedupe";
import { claimsEpoch } from "./epoch";
import { auditArguments, gateAsync } from "./gate";
import type { Served } from "./gate";
import {
  eventDecision,
  quotedChunk,
} from "./ledger";
import { WITHHELD_SCAN_BOUND } from "./query-events";
import { isQuestionQuery } from "../search/relax";
import { ServeError } from "./types";
import type { CanonChunk, QuotedChunk, ServeContext, ResponseContract, ResponseEnvelope } from "./types";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA } from "./types";
import { retrievalCandidates } from "./retrieval";
import { currentQuotedSource } from "./ledger";
import { attachSubjectLabels, canonSubjects, projectSubjectLabels } from "./subject-labels";

const SEARCH_SCOPES = ["canon", "ledger", "all"] as const;

const MAX_QUERY_CHARS = 512;
const MAX_SCOPE_IDS = 16;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** Code points of captured text a ledger hit carries unless the caller asks for `full_text`. */
const LEDGER_EXCERPT = 600;
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
  /** Return whole captured records instead of a bounded excerpt. */
  full_text?: boolean;
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
  fullText: boolean,
  matches?: ReturnType<typeof servedTextMatcher>["matches"],
  semantic?: RetrievalDomain,
): Classification {
  // Candidate previews must not charge redactions to the response. Render the
  // final selected rows with the call's redactor after applying its limit.
  index = { ...index, sourceContext: {
    ...index.sourceContext, redactor: createRedactor(index.sourceContext.principal, index.sourceContext.servingSecrets),
  } };
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
      const { excerpt, truncated } = excerptOf(page.body, LEDGER_EXCERPT, index.sourceContext);
      const chunk = canonChunk(index, page, decision, excerpt, truncated);
      if (matches !== undefined && !currentSemanticNomination(index.sourceContext, index, semantic, hit.doc_id) && !matches(
        searchableText(typeof page.data["title"] === "string" ? page.data["title"] : "", undefined, index.sourceContext.servingSecrets),
        searchableText(page.body, LEDGER_EXCERPT, index.sourceContext.servingSecrets),
      )) continue;
      seen.add(hit.doc_id);
      result.canon.push(chunk);
      continue;
    }

    // An earlier version of an edited record is evidence, not a current answer.
    if (!isCurrentVersion(db, bareRetrievalId(hit.doc_id), {
      ceiling: requireCeiling(grant.ceiling),
      ...(grant.types === null ? {} : { types: grant.types }),
      ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
      ...(grant.since === null ? {} : { since: grant.since }),
      ...(grant.until === null ? {} : { until: grant.until }),
      source: { owner: index.sourceContext.principal.kind === "owner", purpose: index.sourceContext.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant) },
    })) continue;
    const quoted = currentQuotedSource(db, bareRetrievalId(hit.doc_id));
    if (quoted === null) continue;
    const decision = eventDecision(grant, quoted, index.sourceContext);
    if (!decision.allow) {
      result.withheld.push({ id: quoted.event_id, reason: decision.reason });
      continue;
    }
    const chunk = boundedQuote(quotedChunk(quoted, decision.sensitivity, index.sourceContext, fullText ? quoted.text.length : 4096), fullText, index.sourceContext);
    if (matches !== undefined && !currentSemanticNomination(index.sourceContext, index, semantic, hit.doc_id) && !matches("", searchableText(quoted.text, fullText ? undefined : LEDGER_EXCERPT, index.sourceContext.servingSecrets))) continue;
    seen.add(hit.doc_id);
    result.quoted.push(chunk);
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

function boundedQuote(chunk: QuotedChunk, fullText: boolean, ctx: ServeContext): QuotedChunk {
  if (fullText) return chunk;
  const { excerpt, truncated } = excerptOf(chunk.text, LEDGER_EXCERPT, ctx);
  return truncated ? { ...chunk, text: excerpt, truncated: true } : chunk;
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
  /**
   * Present when the query was relaxed: the share of its content words each
   * served page or capture holds, keyed by page id or event id. A caller that
   * wants a stricter answer than the built-in floor thresholds it.
   */
  coverage?: Record<string, number>;
}

export async function serveSearch<C extends ResponseContract = typeof ENVELOPE_SCHEMA>(
  ctx: ServeContext,
  args: SearchArgs | SearchArgsV2,
  contract: C = ENVELOPE_SCHEMA as C,
): Promise<ResponseEnvelope<SearchData, C, { gaps: readonly import("../contracts/scoped-tools").ReadGap[] }>> {
  return gateAsync(ctx, "search", auditArguments(args), async ({ ctx, at }): Promise<Served<SearchData>> => {
    const normalized = normalizeReadArgs(ctx, "search", args, contract);
    ctx = normalized.ctx;
    const request = normalized.args as unknown as SearchArgs;
    const grant = ctx.principal.grant;
    const query = text("query", request.query, MAX_QUERY_CHARS);
    const scope =
      request.scope === undefined
        ? "canon"
        : enumOf("scope", request.scope, SEARCH_SCOPES);
    const rows = limit("limit", request.limit, MAX_LIMIT, DEFAULT_LIMIT);
    const fullText = flag("full_text", request.full_text);
    const types = scopedTypes(
      grant,
      request.types === undefined
        ? undefined
        : idList("types", request.types, MAX_SCOPE_IDS),
    );
    const subjects = scopedSubjects(
      grant,
      request.subjects === undefined
        ? undefined
        : idList("subjects", request.subjects, MAX_SCOPE_IDS),
    );
    const window = scopedWindow(
      grant,
      request.since === undefined ? undefined : rfc3339("since", request.since),
      request.until === undefined ? undefined : rfc3339("until", request.until),
    );

    const base: Omit<SearchOptions, "ceiling"> = {
      ...(ctx.selection === undefined ? {} : { selection: ctx.selection }),
      scope,
      limit: rows,
      ...(types === undefined ? {} : { types }),
      ...(subjects === undefined ? {} : { subjects }),
      ...window,
    };

    const matcher = ctx.principal.kind === "owner" ? undefined : servedTextMatcher(query);
    try {
      const nominated = await retrievalCandidates(ctx, query, { ...base, ceiling: grant.ceiling }, { canon: LEDGER_EXCERPT, ...(fullText ? {} : { event: LEDGER_EXCERPT }) });
      // Re-read current canon and evidence only after the engine finishes.
      const index = loadCanon(ctx);
      base.excludePaths = [...index.holds];
      const seen = new Set<string>();
      const narrowed = { ...grant, ...(types === undefined ? {} : { types }), ...(subjects === undefined ? {} : { subjects }), ...(window.since === undefined ? {} : { since: window.since }), ...(window.until === undefined ? {} : { until: window.until }) };
      const classified: Classification = { canon: [], quoted: [], withheld: [] };
      const rankedOpts = {
        canonIds: index.pages.filter(page => eligible(page) && pageDecision(index, narrowed, page).allow).map(page => `page:${page.id}`),
        canonPaths: index.pages.filter(page => authorize(narrowed, pageScope(ctx, page)).allow).map(page => page.relPath),
        ...base,
        limit: MAX_RETRIEVAL_LIMIT,
        ceiling: grant.ceiling,
        source: {
          owner: ctx.principal.kind === "owner",
          purpose: ctx.sourcePurpose ?? "recall",
          deny_classes: denyClassesOf(grant),
        },
      };
      const degraded = new Set<string>();
      const coverage = new Map<string, number>();
      const read = contract === ENVELOPE_V2_SCHEMA ? null : snapshotSearchRead(ctx, index.generation);
      let offset = 0;
      let previousPage = "";
      // Page the same rank order until MAX_RETRIEVAL_LIMIT authorized hits or the
      // real end. FTS provenance is not an authorization predicate.
      while (true) {
        if (read !== null) assertSearchRead(ctx, read);
        const ranked = searchAuditCandidates(ctx.db, query, {
          ...rankedOpts,
          ...(offset === 0 ? {} : { offset }),
        });
        for (const reason of ranked.degraded) if (!reason.startsWith("index-")) degraded.add(reason);
        for (const candidate of ranked.candidates) if (candidate.coverage !== undefined) coverage.set(bareRetrievalId(candidate.doc_id), candidate.coverage);
        if (ranked.candidates.length === 0) break;
        const pageKey = ranked.candidates.map((hit) => hit.doc_id).join("\0");
        if (pageKey === previousPage) break;
        previousPage = pageKey;
        absorbClassification(
          classified,
          classify(ctx.db, index, narrowed, ranked.candidates, seen, fullText, matcher?.matches),
        );
        if (
          authorizedCount(classified) >= MAX_RETRIEVAL_LIMIT ||
          ranked.candidates.length < MAX_RETRIEVAL_LIMIT
        ) {
          break;
        }
        offset += ranked.candidates.length;
      }
      const question = isQuestionQuery(query);
      if (!question) {
      absorbClassification(
        classified,
        classify(
          ctx.db,
          index,
          narrowed,
          nominated.ids.filter(id => nominated.semantic === undefined || currentSemanticNomination(ctx, index, nominated.semantic, id)).map((doc_id) => ({
            doc_id,
            scope: doc_id.startsWith("page:") ? "canon" : "ledger",
          } as const)),
          seen,
          fullText,
          matcher?.matches,
          nominated.semantic,
        ),
      );
      // Preserve nomination deduplication, including denied nominations. Ranked
      // pages retain only admitted identities; an arbitrary denied prefix must
      // not accumulate in the cross-page set. Each page has its own bounded set.
      for (const id of nominated.ids) seen.add(id);
      }
      // Permission denials remain owner audit data, outside the visible rank window.
      if (ctx.principal.kind === "owner") {
        for (let skipped = 0; skipped < WITHHELD_SCAN_BOUND; skipped += MAX_RETRIEVAL_LIMIT) {
          const sample = searchAuditCandidates(ctx.db, query, { ...base, limit: MAX_RETRIEVAL_LIMIT, source: rankedOpts.source, offset: skipped });
          const denied = classify(ctx.db, index, narrowed, sample.candidates, seen, fullText, matcher?.matches).withheld;
          const room = SEARCH_WITHHELD_CAP - classified.withheld.length;
          if (room > 0) classified.withheld.push(...denied.slice(0, room));
          if (sample.candidates.length < MAX_RETRIEVAL_LIMIT) break;
          if (skipped + sample.candidates.length >= WITHHELD_SCAN_BOUND && classified.withheld.length > 0) degraded.add("scan-bound");
        }
      }
      const canon = classified.canon.slice(0, rows).map(candidate => {
        const page = index.byId.get(candidate.page_id)!;
        const decision = pageDecision(index, narrowed, page);
        if (!decision.allow) throw new ServeError("held", "canon evidence unavailable");
        const { excerpt, truncated } = excerptOf(page.body, LEDGER_EXCERPT, index.sourceContext);
        return canonChunk(index, page, decision, excerpt, truncated);
      });
      const cited = eventsCitedByPages(canon.flatMap(chunk => index.byId.get(chunk.page_id) ?? []), classified.quoted.map(chunk => chunk.event_id));
      const quoted = classified.quoted.filter(chunk => !cited.has(chunk.event_id)).slice(0, Math.max(0, rows - canon.length)).map(candidate => {
        const source = currentQuotedSource(ctx.db, candidate.event_id);
        if (source === null) throw new ServeError("held", "evidence unavailable");
        const decision = eventDecision(narrowed, source, index.sourceContext);
        if (!decision.allow) throw new ServeError("held", "evidence unavailable");
        return boundedQuote(quotedChunk(source, decision.sensitivity, index.sourceContext, fullText ? source.text.length : 4096), fullText, index.sourceContext);
      });
      if (canon.length + quoted.length > 0) degraded.delete(NO_MATCH_LABEL);
      else if (question) degraded.add(NO_MATCH_LABEL);
      if ((scope !== "ledger" && visibleIndexDegraded(index, narrowed, "search")) || (scope !== "canon" && visibleLedgerIndexMissing(ctx, narrowed))) degraded.add("index-degraded");
      const canonicalSubjects = new Map(canon.map(chunk => [chunk.page_id, canonSubjects(index, index.byId.get(chunk.page_id)!)]));
      const projection = projectSubjectLabels(index, narrowed, at, [...canonicalSubjects.values()].flat().concat(quoted.flatMap(chunk => chunk.subjects)), canon.length + quoted.length);
      const audit = new Map<string, AuditItem>();
      for (const chunk of [...canon, ...quoted]) {
        const subjects = "page_id" in chunk ? canonicalSubjects.get(chunk.page_id)! : chunk.subjects;
        for (const item of attachSubjectLabels(projection, chunk, subjects)) audit.set(item.id, item);
      }
      for (const reason of nominated.degraded) degraded.add(reason);
      for (const reason of projection.degraded) degraded.add(reason);

      // Coverage is evidence about released words, not the raw index's secrets.
      if (matcher !== undefined) {
        for (const chunk of canon) {
          const page = index.byId.get(chunk.page_id)!;
          coverage.set(chunk.page_id, matcher.coverage(searchableText(String(page.data["title"] ?? ""), undefined, ctx.servingSecrets), searchableText(page.body, LEDGER_EXCERPT, ctx.servingSecrets)));
        }
        for (const chunk of quoted) {
          const source = currentQuotedSource(ctx.db, chunk.event_id)!;
          coverage.set(chunk.event_id, matcher.coverage("", searchableText(source.text, fullText ? undefined : LEDGER_EXCERPT, ctx.servingSecrets)));
        }
      }
      const scores = degraded.has(RELAXED_LABEL) ? Object.fromEntries([...canon.map(chunk => chunk.page_id), ...quoted.map(chunk => chunk.event_id)].flatMap(id => { const share = coverage.get(id); return share === undefined ? [] : [[id, share] as const]; })) : undefined;
      return {
        canon, quoted, audit_served: [...audit.values()],
        authorization: {
          ...(nominated.semantic === undefined ? {} : { retrieval: [nominated.semantic] }),
          pages: canon.map((chunk) => ({ id: chunk.page_id, hash: index.byId.get(chunk.page_id)!.contentHash, sensitivity: chunk.sensitivity })),
          events: quoted.map((chunk) => ({ id: chunk.event_id, sensitivity: chunk.sensitivity })),
        },
        withheld: classified.withheld,
        ...(degraded.size === 0 ? {} : { data: { degraded: [...degraded], ...(scores === undefined ? {} : { coverage: scores }) } }),
      };
    } finally {
      matcher?.close();
    }
  }, contract);
}
