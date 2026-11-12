import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { liveEventIds } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
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
 * Serving, grant revocation and source erasure find a page by the events it
 * cites, so a page must name every source its claims rest on. Each claim is
 * cited by one live event from every source with live evidence for it
 * (preferring events the page already names), or by all of its events when
 * none is live, which keeps a page resting only on ended evidence visibly
 * inadmissible. The page's other live sources come next, then this write's
 * further evidence, while room lasts. When the required citations alone do
 * not fit, the list is longer than a page may hold and the write is refused,
 * as before. Purged ids, tombstones and versions a deletion ended are kept;
 * only a version whose record has since come back is dropped. The claim row
 * keeps its full provenance.
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
  for (const cite of [...kept, ...own]) for (const id of cite.required) chosen.add(id);
  const returned = returnedVersions(db, prior);
  const livePrior = liveEventIds(db, prior.map(eventIdFromReference));
  for (const id of prior) {
    const event = eventIdFromReference(id);
    if (!livePrior.has(event) && !returned.has(event)) chosen.add(id);
  }
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
      ...own.flatMap((cite) => [...cite.ids, ...cite.required]),
      ...kept.flatMap((cite) => cite.required),
    ]),
  ].filter((id) => chosen.has(id));
}

interface Citations {
  /** Live events, at most a page's worth, preferred first; all events when none is live. */
  readonly ids: string[];
  /** One live event per source with live evidence; all events when none is live. */
  readonly required: string[];
  readonly live: boolean;
}

function claimCitations(db: Database, claim: Claim, prefer: readonly string[]): Citations {
  const own = new Set(claim.provenance);
  const ordered = [
    ...new Set([...prefer.map(eventIdFromReference).filter((id) => own.has(id)), ...claim.provenance]),
  ];
  const live: string[] = [];
  for (let at = 0; at < ordered.length && live.length < MAX_FRONTMATTER_ARRAY_ITEMS; at += LIVE_BATCH) {
    const batch = ordered.slice(at, at + LIVE_BATCH);
    const found = liveEventIds(db, batch);
    for (const id of batch) if (found.has(id) && live.length < MAX_FRONTMATTER_ARRAY_ITEMS) live.push(id);
  }
  if (live.length === 0) {
    const all = ordered.slice(0, MAX_FRONTMATTER_ARRAY_ITEMS);
    return { ids: all, required: all, live: false };
  }
  return { ids: live, required: firstLivePerSource(db, ordered), live: true };
}

/** One live event for each source key (unbound events form one group) in `ordered`, in that order. */
function firstLivePerSource(db: Database, ordered: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  const keyOf = db.query<{ value: string; source_key: string | null }, [string]>(
    `SELECT j.value AS value, b.source_key AS source_key FROM json_each(?) j
       LEFT JOIN source_event_bindings b ON b.event_id = j.value`,
  );
  for (let at = 0; at < ordered.length; at += KEY_BATCH) {
    const rows = keyOf.all(JSON.stringify(ordered.slice(at, at + KEY_BATCH)));
    const byId = new Map(rows.map((row) => [row.value, row.source_key ?? ""]));
    for (const id of ordered.slice(at, at + KEY_BATCH)) {
      const key = byId.get(id) ?? "";
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [id]);
      else group.push(id);
    }
  }
  const required: string[] = [];
  for (const group of groups.values()) {
    for (let at = 0; at < group.length; at += LIVE_BATCH) {
      const batch = group.slice(at, at + LIVE_BATCH);
      const found = liveEventIds(db, batch);
      const first = batch.find((id) => found.has(id));
      if (first !== undefined) { required.push(first); break; }
    }
  }
  return required;
}

/**
 * Of these cited ids, the versions a tombstone ended whose record has a newer
 * live version since: the record came back, so the ended version may go.
 */
function returnedVersions(db: Database, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(db.query<{ event_id: string }, [string]>(
    `SELECT e.event_id AS event_id FROM events e
      WHERE e.event_id IN (SELECT value FROM json_each(?)) AND e.deleted = 0
        AND EXISTS (SELECT 1 FROM events t
              WHERE t.deleted = 1 AND t.connector_id = e.connector_id AND t.source_record_id = e.source_record_id
                AND (t.accepted_at > e.accepted_at OR (t.accepted_at = e.accepted_at AND t.event_id > e.event_id)))
        AND (SELECT x.deleted FROM events x LEFT JOIN source_event_bindings xb ON xb.event_id = x.event_id
              WHERE x.connector_id = e.connector_id AND x.source_record_id = e.source_record_id
                AND xb.source_key IS (SELECT source_key FROM source_event_bindings WHERE event_id = e.event_id)
              ORDER BY x.accepted_at DESC, x.event_id DESC LIMIT 1) = 0`,
  ).all(JSON.stringify(ids.map(eventIdFromReference))).map((row) => row.event_id));
}

const LIVE_BATCH = 500;
const KEY_BATCH = 5_000;

/**
 * The sources a page should cite instead, when it still names a version of a
 * record that was deleted and has since come back, and every live claim on it
 * has live evidence. Null otherwise, or when nothing would change.
 */
export function recitedSources(
  db: Database,
  prior: readonly string[],
  retained: readonly Claim[],
): string[] | null {
  if (retained.length === 0 || returnedVersions(db, prior).size === 0 ||
      retained.some((claim) => !claimCitations(db, claim, prior).live)) return null;
  const next = citedSources(db, [], prior, retained);
  return next.length > MAX_FRONTMATTER_ARRAY_ITEMS ||
    (next.length === prior.length && next.every((id, index) => id === prior[index])) ? null : next;
}

/**
 * Pages with a receipt that cited a version of a record which was deleted and
 * has since come back. A superset: each page's current bytes decide.
 */
export function pagesCitingEndedVersions(db: Database): string[] {
  if (!tableExists(db, "canon_receipts") || !tableExists(db, "page_index")) return [];
  return db.query<{ page_path: string }, []>(
    `WITH returned AS (
       SELECT t.connector_id, t.source_record_id FROM events t
        WHERE t.deleted = 1
          AND (SELECT x.deleted FROM events x WHERE x.connector_id = t.connector_id AND x.source_record_id = t.source_record_id
                ORDER BY x.accepted_at DESC, x.event_id DESC LIMIT 1) = 0),
     ended AS (
       SELECT DISTINCT e.event_id FROM events t JOIN events e
         ON e.connector_id = t.connector_id AND e.source_record_id = t.source_record_id AND e.deleted = 0
        AND (e.accepted_at < t.accepted_at OR (e.accepted_at = t.accepted_at AND e.event_id < t.event_id))
        WHERE t.deleted = 1 AND (t.connector_id, t.source_record_id) IN (SELECT connector_id, source_record_id FROM returned))
     SELECT DISTINCT r.page_path AS page_path
       FROM canon_receipts r JOIN page_index p ON p.rel_path = r.page_path, json_each(r.provenance) j
      WHERE j.value IN (SELECT event_id FROM ended)
      ORDER BY r.page_path`,
  ).all().map((row) => row.page_path);
}
