import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { liveEventIds } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { compareRfc3339 } from "../agents/time";
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
 * Serving, grant revocation and source erasure find and judge a page by the
 * events it cites, so a page must cite, for each claim, live events the gate
 * cannot tell from all of the claim's live events: every source, every class,
 * every origin and the time span (`gateRepresentatives`, preferring events
 * the page already names), or all of the claim's events when
 * none is live, which keeps a page resting only on ended evidence visibly
 * inadmissible. The page's other live sources come next, then this write's
 * further evidence, while room lasts. When the required citations alone do
 * not fit, the list is longer than a page may hold and the write is refused,
 * as before. Purged ids, tombstones and versions a deletion ended are kept;
 * only a version whose record has since come back is dropped, and the
 * record's current version is cited in its place when a claim on the page
 * rests on it. The claim row keeps its full provenance.
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
  // A returned record's current version takes its ended version's place when a
  // claim on the page rests on it, so a later deletion of the record still
  // finds the page.
  const evidence = new Set([...incoming, ...retained].flatMap((claim) => claim.provenance));
  const successors: string[] = [];
  for (const id of prior) {
    const event = eventIdFromReference(id);
    const current = returned.get(event);
    if (!livePrior.has(event) && current === undefined) chosen.add(id);
    if (current !== undefined && evidence.has(current)) { chosen.add(current); successors.push(current); }
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
      ...successors,
      ...own.flatMap((cite) => [...cite.ids, ...cite.required]),
      ...kept.flatMap((cite) => cite.required),
    ]),
  ].filter((id) => chosen.has(id));
}

interface Citations {
  /** Live events, at most a page's worth, preferred first; all events when none is live. */
  readonly ids: string[];
  /** Live events the canon gate cannot tell from all of them (see `gateRepresentatives`); all events when none is live. */
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
  return { ids: live, required: gateRepresentatives(db, ordered), live: true };
}

/**
 * Live events chosen so that every per-event judgement the canon gate makes
 * over a page's cited events comes out as if all of `ordered`'s live events
 * were cited. The gate reads, per cited event:
 *
 * - its source key and grant, applied to which of text, subjects,
 *   attachments and metadata the event fills, or for an unbound event
 *   whether it is native owner correction evidence
 *   (`ledger/source-grants.ts` `sourceEventsAllowed`, `sourceSensitivity`);
 * - its event classes, against grant deny classes
 *   (`ledger/event-classes.ts` `classesOfEvents`, via `sourceEventsAllowed`
 *   and `serving/canon.ts` `scopeForSources`);
 * - its origin, which must be external (`vault/provenance.ts`
 *   `assessLivePageEvidence`);
 * - its `occurred_at`, through the earliest and latest cited event against a
 *   grant window (`serving/canon.ts` `sourceSpan`).
 *
 * So one live event is kept per (source key, native evidence, filled fields),
 * per class and per origin, plus the earliest and latest live event by
 * `occurred_at`, each the first such event in `ordered`.
 */
function gateRepresentatives(db: Database, ordered: readonly string[]): string[] {
  const facts = eventFacts(db, ordered);
  const groups = new Map<string, string[]>();
  const add = (group: string, id: string): void => {
    const members = groups.get(group);
    if (members === undefined) groups.set(group, [id]); else members.push(id);
  };
  for (const fact of facts) {
    add(`grant\u0000${fact.source_key}\u0000${fact.native}\u0000${fact.fields}`, fact.id);
    add(`origin\u0000${fact.origin}`, fact.id);
    for (const name of fact.classes) add(`class\u0000${name}`, fact.id);
  }
  const liveness = new Map<string, boolean>();
  const isLive = (candidates: readonly string[], at: number): boolean => {
    const id = candidates[at]!;
    if (!liveness.has(id)) {
      const batch = candidates.slice(at, at + LIVE_BATCH).filter((item) => !liveness.has(item));
      const found = liveEventIds(db, batch);
      for (const item of batch) liveness.set(item, found.has(item));
    }
    return liveness.get(id)!;
  };
  const firstLive = (candidates: readonly string[]): string | undefined => {
    for (let at = 0; at < candidates.length; at += 1) if (isLive(candidates, at)) return candidates[at];
    return undefined;
  };
  const required = new Set<string>();
  for (const members of groups.values()) {
    const first = firstLive(members);
    if (first !== undefined) required.add(first);
  }
  const byTime = facts
    .filter((fact) => fact.occurred_at !== null)
    .sort((a, b) => compareOccurred(a.occurred_at!, b.occurred_at!) || a.order - b.order);
  const earliest = firstLive(byTime.map((fact) => fact.id));
  const latest = firstLive(byTime.slice().sort((a, b) => compareOccurred(b.occurred_at!, a.occurred_at!) || a.order - b.order).map((fact) => fact.id));
  if (earliest !== undefined) required.add(earliest);
  if (latest !== undefined) required.add(latest);
  return ordered.filter((id) => required.has(id));
}

interface EventFact {
  readonly id: string;
  readonly order: number;
  readonly source_key: string;
  readonly native: number;
  readonly fields: string;
  readonly origin: string;
  readonly occurred_at: string | null;
  readonly classes: string[];
}

function eventFacts(db: Database, ordered: readonly string[]): EventFact[] {
  const native = tableExists(db, "native_owner_evidence")
    ? "(b.source_key IS NULL AND EXISTS (SELECT 1 FROM native_owner_evidence n WHERE n.event_id = e.event_id AND n.origin = 'correction'))"
    : "0";
  const classes = tableExists(db, "event_classes")
    ? "(SELECT group_concat(c.class, char(31)) FROM event_classes c WHERE c.event_id = e.event_id)"
    : "NULL";
  const query = db.query<{ id: string; source_key: string | null; native: number; fields: string; origin: string; occurred_at: string; classes: string | null }, [string]>(
    `SELECT e.event_id AS id, b.source_key AS source_key, ${native} AS native, e.origin AS origin, e.occurred_at AS occurred_at,
            (length(e.text) > 0) || (SELECT count(*) > 0 FROM json_each(e.subjects)) ||
            (SELECT count(*) > 0 FROM json_each(e.attachments)) || (SELECT count(*) > 0 FROM json_each(e.metadata)) AS fields,
            ${classes} AS classes
       FROM json_each(?) j JOIN events e ON e.event_id = j.value
       LEFT JOIN source_event_bindings b ON b.event_id = e.event_id`,
  );
  const position = new Map(ordered.map((id, index) => [id, index]));
  const facts: EventFact[] = [];
  for (let at = 0; at < ordered.length; at += KEY_BATCH) {
    for (const row of query.all(JSON.stringify(ordered.slice(at, at + KEY_BATCH)))) {
      facts.push({
        id: row.id, order: position.get(row.id) ?? 0, source_key: row.source_key ?? "", native: row.native ? 1 : 0,
        fields: String(row.fields), origin: row.origin, occurred_at: validOccurred(row.occurred_at) ? row.occurred_at : null,
        classes: row.classes === null ? [] : row.classes.split("\u001f").sort(),
      });
    }
  }
  return facts.sort((a, b) => a.order - b.order);
}

function validOccurred(value: string): boolean {
  try { compareRfc3339(value, "occurred_at", value, "occurred_at"); return true; } catch { return false; }
}
function compareOccurred(a: string, b: string): number {
  return compareRfc3339(a, "occurred_at", b, "occurred_at");
}

/**
 * Of these cited ids, the versions a tombstone ended whose record has a newer
 * live version since: the record came back, so the ended version may go.
 */
function returnedVersions(db: Database, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(db.query<{ event_id: string; current: string }, [string]>(
    `SELECT event_id, current FROM (
       SELECT e.event_id AS event_id,
              (SELECT x.event_id FROM events x LEFT JOIN source_event_bindings xb ON xb.event_id = x.event_id
                WHERE x.connector_id = e.connector_id AND x.source_record_id = e.source_record_id
                  AND xb.source_key IS (SELECT source_key FROM source_event_bindings WHERE event_id = e.event_id)
                ORDER BY x.accepted_at DESC, x.event_id DESC LIMIT 1) AS current
         FROM events e
        WHERE e.event_id IN (SELECT value FROM json_each(?)) AND e.deleted = 0
          AND EXISTS (SELECT 1 FROM events t
                WHERE t.deleted = 1 AND t.connector_id = e.connector_id AND t.source_record_id = e.source_record_id
                  AND (t.accepted_at > e.accepted_at OR (t.accepted_at = e.accepted_at AND t.event_id > e.event_id))))
      WHERE (SELECT deleted FROM events WHERE event_id = current) = 0`,
  ).all(JSON.stringify(ids.map(eventIdFromReference))).map((row) => [row.event_id, row.current]));
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
