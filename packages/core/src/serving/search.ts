import { currentSemanticNomination, type RetrievalDomain } from "./retrieval-domain";
import { normalizeReadArgs, type SearchArgsV2 } from "./v2/read-input";
import { searchableText, servedTextMatcher } from "./search-match";
import type { Database } from "bun:sqlite";
import { denyClassesOf } from "../agents";
import { cachedSearchCanonScope, visibleIndexDegraded, visibleLedgerIndexMissing } from "./index-health";
import type { AuditDenial, AuditItem, Grant, Sensitivity } from "../agents";
import { canonReadGeneration } from "../canon/write-intent";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import { purgeReadEpoch } from "../derived-holds";
import { sourcePolicyEpoch, type SourceGrantLookup } from "../ledger/source-grants";
import { requireCeiling } from "../query/sql";
import { bareRetrievalId } from "../retrieval/ids";
import { NO_MATCH_LABEL, RELAXED_LABEL, searchAuditCandidates } from "../search/query";
import type { SearchHit, SearchOptions } from "../search/query";
import type { CanonPage } from "../vault/pages";
import {
  enumOf,
  flag,
  idList,
  resolvedSubjectIdentifier,
  limit,
  rfc3339,
  scopedSubjects,
  scopedTypes,
  scopedWindow,
  text,
} from "./arguments";
import { canonChunk, createPageReadAccess, eligible, excerptOf, loadCanon, pageDecision } from "./canon";
import type { CanonIndex, CanonReadAccess } from "./canon";
import { CanonAccessPhase } from "./canon-access";
import { CanonicalQuoteCollector, eventsCitedByPages } from "./dedupe";
import type { QuotedSource } from "./ledger";
import { claimsEpoch } from "./epoch";
import { auditArguments, gateAsync } from "./gate";
import type { Served } from "./gate";
import {
  authorizeEventsBatch,
  createSourceGrantLookup,
  currentQuotedSourcesBatch,
  currentVersionsBatch,
  ownerCannotHaveDeniedEvents,
  quotedChunk,
  readServableEvents,
} from "./ledger";
import { WITHHELD_SCAN_BOUND } from "./query-events";
import { isQuestionQuery } from "../search/relax";
import { ServeError } from "./types";
import type { CanonChunk, QuotedChunk, ServeContext, ResponseContract, ResponseEnvelope } from "./types";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA } from "./types";
import { retrievalCandidates } from "./retrieval";
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

type AdmittedCanon = {
  page: CanonPage;
  decision: Extract<ReturnType<typeof pageDecision>, { allow: true }>;
};

type AdmittedQuote = {
  event_id: string;
  source: QuotedSource;
  sensitivity: Sensitivity;
};

interface Classification {
  canon: AdmittedCanon[];
  quoted: AdmittedQuote[];
  withheld: AuditDenial[];
}

/**
 * Classifies one pass of identities using batched ledger authorization and
 * shared page-read access. Candidate text is never redacted or chunked until
 * final limit selection, so discarded candidates neither spend redaction CPU
 * nor charge redaction counts to the response.
 */
function classify(
  db: Database,
  index: CanonIndex,
  grant: Grant,
  hits: Pick<SearchHit, "doc_id" | "scope">[],
  seen: Set<string>,
  fullText: boolean,
  readAccess: CanonReadAccess,
  grantOf: SourceGrantLookup,
  matches?: ReturnType<typeof servedTextMatcher>["matches"],
  semantic?: RetrievalDomain,
  withheldOnly = false,
): Classification {
  const result: Classification = { canon: [], quoted: [], withheld: [] };
  const pageSeen = new Set<string>();
  const unseenHits: Pick<SearchHit, "doc_id" | "scope">[] = [];
  const ledgerBareIds: string[] = [];

  for (const hit of hits) {
    if (seen.has(hit.doc_id) || pageSeen.has(hit.doc_id)) continue;
    pageSeen.add(hit.doc_id);
    unseenHits.push(hit);
    if (hit.scope !== "canon") ledgerBareIds.push(bareRetrievalId(hit.doc_id));
  }

  const versionScope = {
    ceiling: requireCeiling(grant.ceiling),
    ...(grant.types === null ? {} : { types: grant.types }),
    ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
    ...(grant.since === null ? {} : { since: grant.since }),
    ...(grant.until === null ? {} : { until: grant.until }),
    source: {
      owner: index.sourceContext.principal.kind === "owner",
      purpose: index.sourceContext.sourcePurpose ?? "recall",
      deny_classes: denyClassesOf(grant),
    },
  };

  if (withheldOnly) {
    // Only denied events matter in withheld-only scans; avoid fetching event
    // text and only check `currentVersionsBatch` on events that are actually denied.
    const metadataMap = ledgerBareIds.length > 0 ? readServableEvents(db, ledgerBareIds) : new Map();
    const metadataList = [...new Set(ledgerBareIds)]
      .map((id) => metadataMap.get(id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    const decisions = authorizeEventsBatch(index.sourceContext, grant, metadataList, grantOf);
    const deniedLedgerIds: string[] = [];
    for (const id of ledgerBareIds) {
      const decision = decisions.get(id);
      if (decision !== undefined && !decision.allow) deniedLedgerIds.push(id);
    }
    const deniedCurrent = deniedLedgerIds.length > 0
      ? currentVersionsBatch(db, deniedLedgerIds, versionScope)
      : new Set<string>();

    for (const hit of unseenHits) {
      if (hit.scope === "canon") {
        const page = index.byId.get(bareRetrievalId(hit.doc_id));
        if (page === undefined || !eligible(page)) continue;
        const decision = pageDecision(index, grant, page, readAccess);
        if (!decision.allow) {
          result.withheld.push({ id: page.id, reason: decision.reason });
        } else {
          seen.add(hit.doc_id);
        }
        continue;
      }
      const bareId = bareRetrievalId(hit.doc_id);
      const decision = decisions.get(bareId);
      if (decision === undefined) continue;
      if (!decision.allow) {
        if (deniedCurrent.has(bareId)) {
          result.withheld.push({ id: bareId, reason: decision.reason });
        }
      } else {
        seen.add(hit.doc_id);
      }
    }
    return result;
  }

  const currentSet = ledgerBareIds.length > 0 ? currentVersionsBatch(db, ledgerBareIds, versionScope) : new Set<string>();
  const currentIds = ledgerBareIds.filter((id) => currentSet.has(id));
  const sources = currentIds.length > 0 ? currentQuotedSourcesBatch(db, currentIds) : new Map<string, QuotedSource>();
  const decisions = sources.size > 0
    ? authorizeEventsBatch(index.sourceContext, grant, [...sources.values()], grantOf)
    : new Map();

  for (const hit of unseenHits) {
    if (hit.scope === "canon") {
      const page = index.byId.get(bareRetrievalId(hit.doc_id));
      // A stale index row is not a denial: the page is simply gone.
      if (page === undefined || !eligible(page)) continue;
      const decision = pageDecision(index, grant, page, readAccess);
      if (!decision.allow) {
        result.withheld.push({ id: page.id, reason: decision.reason });
        continue;
      }
      if (matches !== undefined && !currentSemanticNomination(index.sourceContext, index, semantic, hit.doc_id) && !matches(
        searchableText(typeof page.data["title"] === "string" ? page.data["title"] : "", undefined, index.sourceContext.servingSecrets),
        searchableText(page.body, LEDGER_EXCERPT, index.sourceContext.servingSecrets),
      )) continue;
      seen.add(hit.doc_id);
      result.canon.push({ page, decision });
      continue;
    }

    // An earlier version of an edited record is evidence, not a current answer.
    const bareId = bareRetrievalId(hit.doc_id);
    if (!currentSet.has(bareId)) continue;
    const quoted = sources.get(bareId);
    if (quoted === undefined) continue;
    const decision = decisions.get(bareId);
    if (decision === undefined || !decision.allow) {
      if (decision !== undefined) result.withheld.push({ id: quoted.event_id, reason: decision.reason });
      continue;
    }
    if (matches !== undefined && !currentSemanticNomination(index.sourceContext, index, semantic, hit.doc_id) && !matches("", searchableText(quoted.text, fullText ? undefined : LEDGER_EXCERPT, index.sourceContext.servingSecrets))) continue;
    seen.add(hit.doc_id);
    result.quoted.push({ event_id: quoted.event_id, source: quoted, sensitivity: decision.sensitivity });
  }

  return result;
}

function authorizedCount(result: Classification): number {
  return result.canon.length + result.quoted.length;
}

function absorbClassification(
  into: Classification,
  from: Classification,
  collector: CanonicalQuoteCollector<AdmittedQuote>,
): void {
  for (const entry of from.canon) {
    if (authorizedCount(into) >= MAX_RETRIEVAL_LIMIT) break;
    into.canon.push(entry);
  }
  for (const entry of from.quoted) {
    collector.admit(
      entry.source,
      entry,
      into.quoted,
      Math.max(0, MAX_RETRIEVAL_LIMIT - into.canon.length),
    );
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
        : idList("subjects", request.subjects, MAX_SCOPE_IDS, contract === ENVELOPE_V2_SCHEMA ? resolvedSubjectIdentifier : undefined),
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
      const access = new CanonAccessPhase(index, narrowed);
      const grantOf = createSourceGrantLookup(ctx.db);
      const readAccess = createPageReadAccess(index, narrowed, grantOf);
      const classified: Classification = { canon: [], quoted: [], withheld: [] };
      const quoteCollector = new CanonicalQuoteCollector<AdmittedQuote>();
      const { canonIds, canonPaths, stamp: canonStamp } = cachedSearchCanonScope(index, narrowed, access);
      const rankedOpts = {
        canonIds,
        canonPaths,
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
        if (read !== null && offset > 0) assertSearchRead(ctx, read);
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
          classify(ctx.db, index, narrowed, ranked.candidates, seen, fullText, readAccess, grantOf, matcher?.matches),
          quoteCollector,
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
          readAccess,
          grantOf,
          matcher?.matches,
          nominated.semantic,
        ),
        quoteCollector,
      );
      // Preserve nomination deduplication, including denied nominations. Ranked
      // pages retain only admitted identities; an arbitrary denied prefix must
      // not accumulate in the cross-page set. Each page has its own bounded set.
      for (const id of nominated.ids) seen.add(id);
      }
      // Permission denials remain owner audit data, outside the visible rank window.
      if (ctx.principal.kind === "owner") {
        const canonIdSet = new Set(canonIds);
        const allEligibleCanonAdmitted = scope === "ledger" || index.pages.every((page) => !eligible(page) || canonIdSet.has(`page:${page.id}`));
        const skipWithheldScan =
          classified.withheld.length === 0 &&
          allEligibleCanonAdmitted &&
          (scope === "canon" || ownerCannotHaveDeniedEvents(ctx, narrowed, grantOf));
        if (!skipWithheldScan) {
          // One statement ranks every window of the bounded scan.
          const scanned = searchAuditCandidates(ctx.db, query, { ...base, limit: MAX_RETRIEVAL_LIMIT, source: rankedOpts.source, windows: WITHHELD_SCAN_BOUND / MAX_RETRIEVAL_LIMIT }).candidates;
          for (let skipped = 0; skipped < WITHHELD_SCAN_BOUND; skipped += MAX_RETRIEVAL_LIMIT) {
            const sample = scanned.slice(skipped, skipped + MAX_RETRIEVAL_LIMIT);
            const denied = classify(ctx.db, index, narrowed, sample, seen, fullText, readAccess, grantOf, matcher?.matches, undefined, true).withheld;
            const room = SEARCH_WITHHELD_CAP - classified.withheld.length;
            if (room > 0) classified.withheld.push(...denied.slice(0, room));
            if (sample.length < MAX_RETRIEVAL_LIMIT) break;
            if (skipped + sample.length >= WITHHELD_SCAN_BOUND && classified.withheld.length > 0) degraded.add("scan-bound");
          }
        }
      }
      const canon = classified.canon.slice(0, rows).map(({ page, decision }) => {
        const { excerpt, truncated } = excerptOf(page.body, LEDGER_EXCERPT, index.sourceContext);
        return canonChunk(index, page, decision, excerpt, truncated, true);
      });
      const cited = eventsCitedByPages(canon.flatMap(chunk => index.byId.get(chunk.page_id) ?? []), classified.quoted.map(entry => entry.event_id));
      const selectedQuotes = classified.quoted.filter(entry => !cited.has(entry.event_id)).slice(0, Math.max(0, rows - canon.length));
      const quoted = selectedQuotes.map(({ source, sensitivity }) =>
        boundedQuote(quotedChunk(source, sensitivity, index.sourceContext, fullText ? source.text.length : 4096), fullText, index.sourceContext),
      );
      if (canon.length + quoted.length > 0) degraded.delete(NO_MATCH_LABEL);
      else if (question) degraded.add(NO_MATCH_LABEL);
      if ((scope !== "ledger" && visibleIndexDegraded(index, narrowed, "search", index.pages, access, canonStamp)) || (scope !== "canon" && visibleLedgerIndexMissing(ctx, narrowed))) degraded.add("index-degraded");
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
        for (const { source } of selectedQuotes) {
          coverage.set(source.event_id, matcher.coverage("", searchableText(source.text, fullText ? undefined : LEDGER_EXCERPT, ctx.servingSecrets)));
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
