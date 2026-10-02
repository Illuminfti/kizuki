import type { AuditDenial } from "../agents";
import { bareRetrievalId } from "../retrieval/ids";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import { RELAXED_LABEL, searchAuditCandidates } from "../search/query";
import { currentQuotedSource, eventDecision, quotedChunk } from "./ledger";
import type { QuotedChunk, ServeContext } from "./types";

/**
 * Maximum candidate identities inspected by one floor scan. Source policy
 * and sensitivity are applied before LIMIT for the answer; the owner may
 * separately inspect a bounded sample of withheld identities.
 */
export const WITHHELD_SCAN_BOUND = 500;

export interface MatchingEvents {
  quoted: QuotedChunk[];
  withheld: AuditDenial[];
  degraded: string[];
}

/**
 * The captures that answer `query`, most relevant first, each rechecked
 * against the grant and the current ledger. Recency does not pick them.
 */
export function matchingEvents(
  ctx: ServeContext,
  query: string,
  opts: {
    limit: number;
    subjects?: string[];
    kinds?: string[];
    since?: string;
    until?: string;
  },
): MatchingEvents {
  const grant = ctx.principal.grant;
  const quoted: QuotedChunk[] = [];
  const withheld: AuditDenial[] = [];
  const degraded = new Set<string>();
  const seen = new Set<string>();
  let candidatesScanned = 0;
  for (let offset = 0; quoted.length < opts.limit; ) {
    const page = searchAuditCandidates(ctx.db, query, {
      scope: "ledger",
      limit: MAX_RETRIEVAL_LIMIT,
      ceiling: grant.ceiling,
      source: { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" },
      ...(opts.subjects === undefined ? {} : { subjects: opts.subjects }),
      ...(opts.kinds === undefined ? {} : { types: opts.kinds }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      ...(offset === 0 ? {} : { offset }),
    });
    // Only what says the answer is loose. Whether the index is stale is the canon path's report.
    if (page.degraded.includes(RELAXED_LABEL)) degraded.add(RELAXED_LABEL);
    for (const candidate of page.candidates) {
      const eventId = bareRetrievalId(candidate.doc_id);
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      const source = currentQuotedSource(ctx.db, eventId);
      if (source === null) continue;
      const decision = eventDecision(grant, source, ctx);
      if (!decision.allow) {
        withheld.push({ id: eventId, reason: decision.reason });
        continue;
      }
      if (quoted.length < opts.limit) quoted.push(quotedChunk(source, decision.sensitivity, ctx));
    }
    candidatesScanned += page.candidates.length;
    if (page.candidates.length < MAX_RETRIEVAL_LIMIT) break;
    if (candidatesScanned >= WITHHELD_SCAN_BOUND) {
      degraded.add("scan-bound");
      break;
    }
    offset += page.candidates.length;
  }
  return { quoted, withheld, degraded: [...degraded] };
}
