import { denyClassesOf, type Grant } from "../agents";
import { MAX_RETRIEVAL_DOCUMENT_SCOPE, retrievalDocumentScope, type RetrievalDoc, type RetrievalDocumentScope } from "../contracts/retrieval";
import { timelineSelection } from "../query/timeline";
import { requireCeiling } from "../query/sql";
import { isCurrentVersion } from "../search/versions";
import type { SearchOptions } from "../search/query";
import { isRfc3339 } from "../util/time";
import { stringArray } from "../vault/pages";
import { eligible, loadCanon, pageDecision, type CanonIndex } from "./canon";
import { currentQuotedSource, eventDecision } from "./ledger";
import { searchableText } from "./search-match";
import type { ServeContext } from "./types";

/** Bounded serialized policy domain; it carries hashes and provenance, never text. */
const DOMAIN_BYTES = 4 * 1024 * 1024;
const CONTENT_BYTES = 4 * 1024 * 1024;
export interface RetrievalReleaseBounds { readonly canon: number; readonly event?: number; }
export interface RetrievalDomain {
  readonly documents: readonly RetrievalDocumentScope[];
  readonly options: SearchOptions;
  readonly grant: Grant;
  readonly bounds: RetrievalReleaseBounds;
  readonly partial: boolean;
  readonly unavailable: boolean;
}

function sourceScope(ctx: ServeContext, grant: Grant) {
  return { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant) };
}
function currentDocument(ctx: ServeContext, index: CanonIndex, grant: Grant, id: string): RetrievalDoc | null {
  if (id.startsWith("page:")) {
    const page = index.byId.get(id.slice(5));
    if (!page || !eligible(page)) return null;
    const decision = pageDecision(index, grant, page);
    if (!decision.allow) return null;
    return { doc_id: id, kind: "page", title: typeof page.data["title"] === "string" ? page.data["title"] : page.id,
      text: page.body, sensitivity: decision.sensitivity, taint: decision.taint, authority: decision.evidence.revision.authority,
      subjects: [...new Set([...stringArray(page.data["subjects"]), ...(typeof page.data["x-subject-id"] === "string" ? [page.data["x-subject-id"]] : [])])],
      provenance: decision.evidence.sourceIds, occurred_at: null, updated_at: isRfc3339(decision.evidence.revision.at) ? decision.evidence.revision.at : null };
  }
  if (!id.startsWith("event:")) return null;
  const eventId = id.slice(6);
  if (!isCurrentVersion(ctx.db, eventId, { ceiling: requireCeiling(grant.ceiling), source: sourceScope(ctx, grant),
    ...(grant.types === null ? {} : { types: grant.types }), ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
    ...(grant.since === null ? {} : { since: grant.since }), ...(grant.until === null ? {} : { until: grant.until }) })) return null;
  const source = currentQuotedSource(ctx.db, eventId);
  if (!source) return null;
  const decision = eventDecision(grant, source, ctx);
  if (!decision.allow) return null;
  const row = ctx.db.query<{ observed_at: string }, [string]>("SELECT observed_at FROM events WHERE event_id=?").get(eventId);
  if (!row) return null;
  return { doc_id: id, kind: "event", title: source.connector_id, text: source.text, sensitivity: decision.sensitivity,
    taint: "quoted", authority: "connector_evidence", subjects: source.subjects, provenance: [eventId], occurred_at: source.occurred_at, updated_at: row.observed_at };
}
function releasable(ctx: ServeContext, doc: RetrievalDoc, bounds: RetrievalReleaseBounds): boolean {
  return ctx.principal.kind === "owner" || (doc.title === searchableText(doc.title, undefined, ctx.servingSecrets) &&
    doc.text === searchableText(doc.text, doc.kind === "page" ? bounds.canon : bounds.event, ctx.servingSecrets));
}

/** Source/class/time/type policy selects identities before the finite candidate cap. */
export function collectRetrievalDomain(ctx: ServeContext, options: SearchOptions, bounds: RetrievalReleaseBounds): RetrievalDomain {
  const grant: Grant = { ...ctx.principal.grant, ceiling: options.ceiling,
    ...(options.types === undefined ? {} : { types: options.types }), ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
    ...(options.since === undefined ? {} : { since: options.since }), ...(options.until === undefined ? {} : { until: options.until }) };
  const scoped = { ...ctx, principal: { ...ctx.principal, grant } };
  const index = loadCanon(scoped);
  const ids: string[] = [];
  if (options.scope !== "ledger") {
    for (const page of index.pages) if (eligible(page) && pageDecision(index, grant, page).allow) ids.push(`page:${page.id}`);
  }
  if (options.scope !== "canon" && ids.length <= MAX_RETRIEVAL_DOCUMENT_SCOPE) {
    const selected = timelineSelection(ctx.db, { ceiling: grant.ceiling, limit: MAX_RETRIEVAL_DOCUMENT_SCOPE + 1 - ids.length,
      source: sourceScope(ctx, grant), currentVersionsOnly: true,
      ...(grant.types === null ? {} : { kinds: grant.types }), ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
      ...(grant.since === null ? {} : { since: grant.since }), ...(grant.until === null ? {} : { until: grant.until }) });
    ids.push(...selected.map(row => `event:${row.event_id}`));
  }
  const unavailable = (): RetrievalDomain => ({ documents: [], options: { ...options }, grant, bounds, partial: true, unavailable: true });
  if (ids.length > MAX_RETRIEVAL_DOCUMENT_SCOPE) return unavailable();
  const documents: RetrievalDocumentScope[] = [];
  let bytes = 0, content = 0, partial = false;
  for (const id of ids) {
    const doc = currentDocument(scoped, index, grant, id);
    if (!doc) continue;
    if (!releasable(ctx, doc, bounds)) { partial = true; continue; }
    content += Buffer.byteLength(doc.title) + Buffer.byteLength(doc.text);
    if (content > CONTENT_BYTES) return unavailable();
    const entry = retrievalDocumentScope(doc);
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > DOMAIN_BYTES) return unavailable();
    documents.push(entry);
  }
  return { documents, options: { ...options }, grant, bounds, partial, unavailable: false };
}

/** The pre-await semantic permission never transfers to changed current bytes. */
export function currentSemanticNomination(ctx: ServeContext, index: CanonIndex, domain: RetrievalDomain | undefined, id: string): boolean {
  const expected = domain?.documents.find(row => row.doc_id === id);
  if (!expected || !domain) return false;
  const doc = currentDocument(ctx, index, domain.grant, id);
  return doc !== null && releasable(ctx, doc, domain.bounds) && JSON.stringify(retrievalDocumentScope(doc)) === JSON.stringify(expected);
}

/** Rank and diagnostics depend on the complete authorized candidate domain. */
export function retrievalDomainCurrent(ctx: ServeContext, domain: RetrievalDomain): boolean {
  const current = collectRetrievalDomain(ctx, domain.options, domain.bounds);
  return current.partial === domain.partial && current.unavailable === domain.unavailable &&
    JSON.stringify(current.documents) === JSON.stringify(domain.documents);
}
