import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { liveEventIds } from "../ledger/ledger";
import { eventIdFromReference } from "../retrieval/ids";
import { MAX_FRONTMATTER_ARRAY_ITEMS } from "../vault/schema";

/**
 * The events a legacy page write cites in `sources`.
 *
 * A claim's provenance only grows: every re-observation appends its event, so
 * a subject seen in thousands of events carries thousands of ids, and a record
 * that was deleted and came back keeps the version a tombstone ended. A page
 * names at most `MAX_FRONTMATTER_ARRAY_ITEMS` sources, and positive admission
 * needs every one of them live. Citing the whole provenance made such pages
 * unwritable or unservable.
 *
 * So a claim is cited by its live events, or by all of them when none is live,
 * which keeps a page that rests only on ended evidence visibly inadmissible.
 * Every claim keeps one citation, preferring one the page already names. The
 * page's other live sources come next, then this write's further evidence,
 * while room lasts. A prior source a tombstone has ended, and that no claim
 * still needs, is dropped. The claim row keeps its full provenance.
 */
export function citedSources(
  db: Database,
  incoming: readonly Claim[],
  prior: readonly string[] = [],
  retained: readonly Claim[] = [],
): string[] {
  const own = incoming.map((claim) => claimCitations(db, claim, prior));
  const kept = retained.map((claim) => claimCitations(db, claim, prior));
  const chosen = new Set<string>();
  for (const cite of [...kept, ...own]) {
    for (const id of cite.live ? cite.ids.slice(0, 1) : cite.ids)
      chosen.add(id);
  }
  const priorIds = prior.map(eventIdFromReference);
  const livePrior = liveEventIds(db, priorIds);
  // Purged evidence is the purge pipeline's to rewrite. Only a version that a
  // tombstone ended, still in the ledger, can leave a page here.
  const stored = new Set(
    db.query<{ event_id: string }, [string]>(
      "SELECT event_id FROM events WHERE event_id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(priorIds)).map((row) => row.event_id),
  );
  for (const id of prior) if (!stored.has(eventIdFromReference(id))) chosen.add(id);
  for (const id of [
    ...prior.filter((id) => livePrior.has(eventIdFromReference(id))),
    ...own.flatMap((cite) => cite.ids),
  ]) {
    if (chosen.size >= MAX_FRONTMATTER_ARRAY_ITEMS) break;
    chosen.add(id);
  }
  return [
    ...new Set([
      ...prior,
      ...own.flatMap((cite) => cite.ids),
      ...kept.flatMap((cite) => cite.ids),
    ]),
  ].filter((id) => chosen.has(id));
}

/** One claim's citable events, at most a page's worth, with those `prefer` names first. */
function claimCitations(
  db: Database,
  claim: Claim,
  prefer: readonly string[],
): { ids: string[]; live: boolean } {
  const own = new Set(claim.provenance);
  const ordered = [
    ...new Set([
      ...prefer.map(eventIdFromReference).filter((id) => own.has(id)),
      ...claim.provenance,
    ]),
  ];
  const live: string[] = [];
  for (
    let at = 0;
    at < ordered.length && live.length < MAX_FRONTMATTER_ARRAY_ITEMS;
    at += LIVE_BATCH
  ) {
    const batch = ordered.slice(at, at + LIVE_BATCH);
    const found = liveEventIds(db, batch);
    for (const id of batch)
      if (found.has(id) && live.length < MAX_FRONTMATTER_ARRAY_ITEMS)
        live.push(id);
  }
  return live.length > 0
    ? { ids: live, live: true }
    : { ids: ordered.slice(0, MAX_FRONTMATTER_ARRAY_ITEMS), live: false };
}

const LIVE_BATCH = 500;
