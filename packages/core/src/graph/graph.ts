import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { readDerivedMeta, stampDerived } from "../derived-meta";
import type { DerivedStamp } from "../derived-meta";
import { assertDerivedDiscoveryReady, markDerivedHeld, readDerivedHolds } from "../derived-holds";
import { latestLedgerCursor } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { bareRetrievalId } from "../retrieval/ids";
import { ulid } from "../util/ulid";
import { compareText } from "../util/order";
import { placeholders } from "../util/sql";
import {
  canonPagesHash,
  isLiveCanonPage,
  listCanonPagesReport,
  stringArray,
} from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { projectablePageEvidence } from "../vault/provenance";
import { linkIndexFromPages, resolveWikilink } from "./resolve";
import type { LinkIndex } from "./resolve";
import { initGraph } from "./schema";

export type GraphEdgeKind = "wikilink" | "subject" | "source";

export interface GraphEdge {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
}

export interface GraphRebuildInput {
  generation: string;
  pages: readonly CanonPage[];
  skipped: readonly SkippedPage[];
  rebuilt_at: string;
  canon_hash: string | null;
}

export interface GraphRebuildResult {
  pages: number;
  edges: number;
  skipped: SkippedPage[];
  rebuilt_at: string;
  generation: string;
  status: "ok" | "degraded";
}

export interface NeighborOptions {
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
  limit?: number;
  ceiling?: Sensitivity;
}

export interface NeighborResult {
  id: string;
  edges: GraphEdge[];
  truncated: boolean;
}

interface StoredEdge {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
  sensitivity: string;
  dest_sensitivity: string | null;
  taint: "clean" | "quoted";
  authority: RetrievalAuthority;
  provenance: string;
}

const FRONTIER_CHUNK = 500;

function withoutCodeSpans(body: string): string {
  const runs: { start: number; length: number; next: number }[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "`") continue;
    const start = index;
    while (body[index + 1] === "`") index += 1;
    runs.push({ start, length: index - start + 1, next: -1 });
  }
  if (runs.length === 0) return body;

  // Index the next exact-length run once. Unmatched runs must not each
  // rescan the rest of a hostile page looking for a closing delimiter.
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    run.next = nextByLength.get(run.length) ?? -1;
    nextByLength.set(run.length, index);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < runs.length;) {
    const run = runs[index]!;
    if (run.next < 0) {
      index += 1;
      continue;
    }
    const closing = runs[run.next]!;
    const end = closing.start + closing.length;
    parts.push(body.slice(cursor, run.start));
    parts.push(body.slice(run.start, end).replace(/[^\n]/g, " "));
    cursor = end;
    index = run.next + 1;
  }
  parts.push(body.slice(cursor));
  return parts.join("");
}

function wikilinks(body: string): string[] {
  const source = withoutCodeSpans(body);
  if (!source.includes("[[")) return [];
  const targets: string[] = [];

  // For each suffix, find the first closing pair after any balanced nested
  // groups. Right-to-left construction makes every lookup constant-time,
  // including an unmatched opener and overlapping delimiters such as [[[.
  const closes = new Int32Array(source.length + 2).fill(-1);
  const nested = new Uint8Array(source.length + 2);
  for (let index = source.length - 2; index >= 0; index -= 1) {
    if (source[index] === "]" && source[index + 1] === "]") {
      closes[index] = index;
    } else if (source[index] === "[" && source[index + 1] === "[") {
      const innerEnd = closes[index + 2]!;
      if (innerEnd >= 0) closes[index] = closes[innerEnd + 2]!;
      nested[index] = 1;
    } else {
      closes[index] = closes[index + 1]!;
      nested[index] = nested[index + 1]!;
    }
  }

  for (let index = 0; index < source.length - 1; index += 1) {
    if (source[index] !== "[" || source[index + 1] !== "[") continue;
    const contentStart = index + 2;
    const closing = closes[contentStart]!;
    if (closing < 0) continue;
    if (nested[contentStart] === 0) {
      const content = source.slice(contentStart, closing);
      const separator = content.indexOf("|");
      const target = (separator < 0 ? content : content.slice(0, separator)).trim();
      if (target.length > 0) targets.push(target);
    }
    index = closing + 1;
  }

  return targets;
}

function pageSensitivity(page: CanonPage): string {
  const value = page.data["sensitivity"];
  return value === "public" || value === "personal" || value === "private"
    ? value
    : "unlabeled";
}

function pageTaint(page: CanonPage): "clean" | "quoted" {
  return page.data["taint"] === "quoted" ? "quoted" : "clean";
}

function destSensitivity(
  kind: GraphEdgeKind,
  dst: string,
  byId: ReadonlyMap<string, CanonPage>,
  eventHints: ReadonlyMap<string, string>,
): string | null {
  switch (kind) {
    case "wikilink": {
      const dest = byId.get(dst);
      return dest === undefined ? null : pageSensitivity(dest);
    }
    case "subject":
      return null;
    case "source":
      return eventHints.get(bareRetrievalId(dst)) ?? "unlabeled";
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unexpected graph edge kind: ${_exhaustive}`);
    }
  }
}

function sourceEventIds(pages: readonly CanonPage[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!isLiveCanonPage(page)) continue;
    for (const source of stringArray(page.data["sources"])) {
      const eventId = bareRetrievalId(source);
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      ids.push(eventId);
    }
  }
  return ids;
}

function eventSensitivityHints(
  db: Database,
  eventIds: readonly string[],
): Map<string, string> {
  const hints = new Map<string, string>();
  if (eventIds.length === 0 || !tableExists(db, "events")) return hints;
  for (const group of chunks(eventIds, FRONTIER_CHUNK)) {
    const rows = db
      .query<{ event_id: string; sensitivity_hint: string | null }, string[]>(
        `SELECT event_id, sensitivity_hint FROM events
          WHERE event_id IN (${placeholders(group.length)})`,
      )
      .all(...group);
    for (const row of rows) {
      const hint = row.sensitivity_hint;
      hints.set(
        row.event_id,
        hint === "public" || hint === "personal" || hint === "private"
          ? hint
          : "unlabeled",
      );
    }
  }
  return hints;
}

function pageEdges(
  page: CanonPage,
  index: LinkIndex,
  byId: ReadonlyMap<string, CanonPage>,
  eventHints: ReadonlyMap<string, string>,
  authority: RetrievalAuthority,
): StoredEdge[] {
  const provenance = JSON.stringify(stringArray(page.data["sources"]));
  const sensitivity = pageSensitivity(page);
  const taint = pageTaint(page);
  const edges: StoredEdge[] = [];
  const seen = new Set<string>();
  const push = (dst: string, kind: GraphEdgeKind) => {
    const key = `${dst}\u0000${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      src: page.id,
      dst,
      kind,
      sensitivity,
      dest_sensitivity: destSensitivity(kind, dst, byId, eventHints),
      taint,
      authority,
      provenance,
    });
  };
  for (const target of wikilinks(page.body)) {
    push(resolveWikilink(index, target) ?? target, "wikilink");
  }
  for (const subject of stringArray(page.data["subjects"])) {
    push(subject, "subject");
  }
  for (const source of stringArray(page.data["sources"])) {
    push(source, "source");
  }
  return edges;
}

function insertEdge(db: Database, edge: StoredEdge): void {
  db.query<
    never,
    [string, string, GraphEdgeKind, string, string | null, string, string, string]
  >(
    `INSERT OR IGNORE INTO graph_edges
       (src, dst, kind, sensitivity, dest_sensitivity, taint, authority, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edge.src,
    edge.dst,
    edge.kind,
    edge.sensitivity,
    edge.dest_sensitivity,
    edge.taint,
    edge.authority,
    edge.provenance,
  );
}

function graphExclusions(db: Database, pages: readonly CanonPage[]) {
  const held = readDerivedHolds(db, pages);
  const evidence = projectablePageEvidence(db, pages);
  const missing = new Set(held.paths);
  const aliases = new Set<string>();
  let withheldCount = held.paths.size;
  for (const page of pages) {
    missing.delete(page.relPath);
    // Unheld inactive pages do not resolve links or suppress ordinary prose targets.
    if (!held.paths.has(page.relPath) && (!isLiveCanonPage(page) || evidence.has(page.relPath))) continue;
    if (!held.paths.has(page.relPath) && isLiveCanonPage(page)) withheldCount += 1;
    held.paths.add(page.relPath);
    held.pageIds.add(page.id);
    const base = page.relPath.split("/").pop()!;
    for (const alias of [page.id, page.relPath, page.relPath.replace(/\.md$/i, ""), base, base.replace(/\.md$/i, ""), page.data["title"]]) {
      if (typeof alias === "string") aliases.add(alias.toLowerCase());
    }
  }
  if (held.paths.size > 0 && tableExists(db, "page_index")) {
    for (const row of db.query<{ page_id: string }, [string]>(
      "SELECT page_id FROM page_index WHERE rel_path IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify([...held.paths]))) held.pageIds.add(row.page_id);
  }
  return { ...held, aliases, complete: missing.size === 0, evidence, withheldCount };
}

function isHeldEdge(edge: StoredEdge, held: ReturnType<typeof graphExclusions>): boolean {
  return held.pageIds.has(edge.dst) || (edge.kind === "wikilink" && held.aliases.has(edge.dst.toLowerCase()));
}

/** Project every live page's edges. Same write as a graph rebuild. */
export function replacePageEdges(
  db: Database,
  pages: readonly CanonPage[],
): void {
  assertDerivedDiscoveryReady(db);
  const held = graphExclusions(db, pages);
  db.exec("DELETE FROM graph_edges");
  // A missing held page leaves its title aliases unknown. Withhold this
  // projection until a complete page snapshot can exclude those relations.
  if (!held.complete) {
    markDerivedHeld(db, "graph", held.withheldCount);
    return;
  }
  const live = pages.filter(page => isLiveCanonPage(page) && !held.paths.has(page.relPath));
  // Keep held pages in resolution so links to them are withheld, rather than
  // falling back to an apparently unrelated raw title or path edge.
  const index = linkIndexFromPages(pages);
  const byId = new Map(live.map((page) => [page.id, page]));
  const eventHints = eventSensitivityHints(db, sourceEventIds(live));
  for (const page of live) {
    for (const edge of pageEdges(page, index, byId, eventHints, held.evidence.get(page.relPath)!.revision.authority)) {
      if (isHeldEdge(edge, held)) continue;
      insertEdge(db, edge);
    }
  }
  markDerivedHeld(db, "graph", held.withheldCount);
}

function removeHeldEdges(db: Database, held: ReturnType<typeof graphExclusions>): void {
  if (held.paths.size === 0) return;
  if (!held.complete) {
    db.exec("DELETE FROM graph_edges");
    return;
  }
  const ids = JSON.stringify([...held.pageIds]);
  db.query(`DELETE FROM graph_edges
             WHERE src IN (SELECT value FROM json_each(?))
                OR dst IN (SELECT value FROM json_each(?))
                OR (kind='wikilink' AND lower(dst) IN (SELECT value FROM json_each(?)))`)
    .run(ids, ids, JSON.stringify([...held.aliases]));
}

/** Remove existing held relations without projecting any new page content. */
export function removeHeldPageEdges(db: Database, pages: readonly CanonPage[]): void {
  const held = graphExclusions(db, pages);
  removeHeldEdges(db, held);
  markDerivedHeld(db, "graph", held.withheldCount);
}

function stampGraphIncomplete(db: Database, skippedCount: number): void {
  const existing = readDerivedMeta(db, "graph");
  const held = readDerivedHolds(db).paths.size;
  stampDerived(db, {
    layer: "graph",
    generation: existing?.generation ?? ulid(),
    rebuilt_at: new Date().toISOString(),
    doc_count: existing?.doc_count ?? 0,
    source_count: existing?.source_count ?? 0,
    skipped_count: skippedCount + held,
    status: "degraded",
    ledger_watermark: existing?.ledger_watermark ?? null,
    canon_hash: held > 0 ? null : existing?.canon_hash ?? null,
    port_id: existing?.port_id ?? null,
    contract: existing?.contract ?? null,
    space: existing?.space ?? null,
  });
}

function restoreGraphStamp(db: Database, pages: readonly CanonPage[]): void {
  const excluded = graphExclusions(db, pages);
  if (excluded.withheldCount > 0) {
    stampGraphIncomplete(db, excluded.withheldCount);
    return;
  }
  const existing = readDerivedMeta(db, "graph");
  if (existing === null || existing.status === "ok") return;
  const live = pages.filter(page => excluded.evidence.has(page.relPath) && !excluded.paths.has(page.relPath));
  const edges =
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM graph_edges",
      )
      .get()?.count ?? 0;
  stampDerived(
    db,
    stampGraph(
      db,
      {
        generation: ulid(),
        pages: live,
        skipped: [],
        rebuilt_at: new Date().toISOString(),
        canon_hash: canonPagesHash(live),
      },
      live.length,
      edges,
    ),
  );
}

/**
 * Incremental graph write. A complete walk projects the live set; a skipped
 * page keeps its edges until the next complete walk, except relations to a
 * page explicitly known to be inactive.
 */
export function refreshPageEdges(
  db: Database,
  page: CanonPage,
  pages: readonly CanonPage[],
  skipped: number,
): void {
  assertDerivedDiscoveryReady(db);
  const held = graphExclusions(db, [...pages.filter(candidate => candidate.relPath !== page.relPath), page]);
  if (!held.complete) {
    db.exec("DELETE FROM graph_edges");
    stampGraphIncomplete(db, skipped);
    return;
  }
  removeHeldEdges(db, held);
  if (skipped === 0) {
    replacePageEdges(db, pages);
    restoreGraphStamp(db, pages);
    return;
  }
  const index = linkIndexFromPages(pages);
  const byId = new Map(
    pages.filter(candidate => held.evidence.has(candidate.relPath) && !held.paths.has(candidate.relPath)).map((candidate) => [candidate.id, candidate]),
  );
  if (isLiveCanonPage(page) && !held.paths.has(page.relPath)) {
    db.query("DELETE FROM graph_edges WHERE src = ?").run(page.id);
    const eventHints = eventSensitivityHints(db, sourceEventIds([page]));
    for (const edge of pageEdges(page, index, byId, eventHints, held.evidence.get(page.relPath)!.revision.authority)) {
      if (isHeldEdge(edge, held)) continue;
      insertEdge(db, edge);
    }
  } else {
    db.query("DELETE FROM graph_edges WHERE src = ? OR dst = ?").run(page.id, page.id);
  }
  stampGraphIncomplete(db, skipped);
}

/** Incremental delete. Incomplete walks drop all relations to this page. */
export function removePageEdges(
  db: Database,
  pageId: string,
  pages: readonly CanonPage[],
  skipped: number,
): void {
  assertDerivedDiscoveryReady(db);
  const held = graphExclusions(db, pages);
  if (!held.complete) {
    db.exec("DELETE FROM graph_edges");
    stampGraphIncomplete(db, skipped);
    return;
  }
  removeHeldEdges(db, held);
  if (skipped === 0) {
    replacePageEdges(db, pages);
    restoreGraphStamp(db, pages);
    return;
  }
  db.query("DELETE FROM graph_edges WHERE src = ? OR dst = ?").run(pageId, pageId);
  stampGraphIncomplete(db, skipped);
}

function stampGraph(
  db: Database,
  input: GraphRebuildInput,
  pages: number,
  edges: number,
  withheld = readDerivedHolds(db).paths.size,
): DerivedStamp {
  const watermark = latestLedgerCursor(db);
  return {
    layer: "graph",
    generation: input.generation,
    rebuilt_at: input.rebuilt_at,
    doc_count: edges,
    source_count: pages,
    skipped_count: input.skipped.length + withheld,
    status: input.skipped.length + withheld > 0 ? "degraded" : "ok",
    ledger_watermark:
      watermark === null
        ? null
        : `${watermark.accepted_at}\t${watermark.event_id}`,
    canon_hash: withheld > 0 ? null : input.canon_hash,
    port_id: null,
    contract: "kizuki.retrieval/v1",
    space: null,
  };
}

function snapshotGraphInput(vaultPath: string): GraphRebuildInput {
  const report = listCanonPagesReport(vaultPath);
  const live = report.pages.filter(isLiveCanonPage);
  return {
    generation: ulid(),
    pages: report.pages,
    skipped: report.skipped,
    rebuilt_at: new Date().toISOString(),
    canon_hash: canonPagesHash(live),
  };
}

/** Rebuild the graph layer. Caller owns the transaction. */
export function rebuildGraphLayer(
  db: Database,
  input: GraphRebuildInput,
): GraphRebuildResult {
  assertDerivedDiscoveryReady(db);
  const held = graphExclusions(db, input.pages);
  const live = input.pages.filter(page => held.evidence.has(page.relPath) && !held.paths.has(page.relPath));
  replacePageEdges(db, input.pages);
  const edges =
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM graph_edges",
      )
      .get()?.count ?? 0;
  stampDerived(db, stampGraph(db, input, live.length, edges, held.withheldCount));
  return {
    pages: live.length,
    edges,
    skipped: [...input.skipped],
    rebuilt_at: input.rebuilt_at,
    generation: input.generation,
    status: input.skipped.length + held.withheldCount > 0 ? "degraded" : "ok",
  };
}

export function rebuildGraph(
  db: Database,
  vaultPathOrInput: string | GraphRebuildInput,
): GraphRebuildResult {
  initGraph(db);
  const input =
    typeof vaultPathOrInput === "string"
      ? snapshotGraphInput(vaultPathOrInput)
      : vaultPathOrInput;
  return db.transaction(() => rebuildGraphLayer(db, input)).immediate();
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function incidentEdges(
  db: Database,
  ids: string[],
  kinds: GraphEdgeKind[] | undefined,
  ceiling: Sensitivity | undefined,
  remaining: number,
): GraphEdge[] {
  if (ids.length === 0 || kinds?.length === 0 || remaining <= 0) return [];
  const collected: GraphEdge[] = [];
  for (const group of chunks(ids, FRONTIER_CHUNK)) {
    if (collected.length >= remaining) break;
    const idSlots = placeholders(group.length);
    const bindings: (string | number)[] = [...group, ...group];
    const extra: string[] = [];
    if (kinds !== undefined) {
      extra.push(`kind IN (${placeholders(kinds.length)})`);
      bindings.push(...kinds);
    }
    if (ceiling !== undefined) {
      extra.push(`sensitivity != 'unlabeled'`);
      extra.push(`${sensitivityRankSql("sensitivity")} <= ?`);
      extra.push(
        `(dest_sensitivity IS NULL OR (dest_sensitivity != 'unlabeled' AND ${sensitivityRankSql("dest_sensitivity")} <= ?))`,
      );
      bindings.push(SENSITIVITY_ORDER[ceiling], SENSITIVITY_ORDER[ceiling]);
    }
    const extraSql = extra.length === 0 ? "" : ` AND ${extra.join(" AND ")}`;
    bindings.push(remaining - collected.length);
    collected.push(
      ...db
        .query<GraphEdge, (string | number)[]>(
          `SELECT src, dst, kind FROM graph_edges
           WHERE (src IN (${idSlots}) OR dst IN (${idSlots}))${extraSql}
           ORDER BY src, dst, kind
           LIMIT ?`,
        )
        .all(...bindings),
    );
  }
  return collected;
}

function sensitivityRankSql(column: string): string {
  return `CASE ${column} WHEN 'public' THEN 0 WHEN 'personal' THEN 1 WHEN 'private' THEN 2 ELSE 99 END`;
}

function validLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > MAX_RETRIEVAL_LIMIT
  ) {
    throw new RangeError(
      `neighbors limit must be an integer between 0 and ${MAX_RETRIEVAL_LIMIT}`,
    );
  }
  return limit;
}

export function neighbors(
  db: Database,
  id: string,
  opts: NeighborOptions = {},
): NeighborResult {
  const depth = opts.depth ?? 1;
  if (depth !== 1 && depth !== 2) {
    throw new RangeError("neighbors depth must be 1 or 2");
  }
  const limit = validLimit(opts.limit ?? MAX_RETRIEVAL_LIMIT);
  if (limit === 0 || opts.kinds?.length === 0) {
    return { id, edges: [], truncated: false };
  }
  if (!tableExists(db, "graph_edges")) {
    return { id, edges: [], truncated: false };
  }

  const seenNodes = new Set([id]);
  const seenEdges = new Set<string>();
  const result: GraphEdge[] = [];
  let frontier = [id];
  let truncated = false;

  for (let level = 0; level < depth && !truncated; level += 1) {
    const available = incidentEdges(
      db,
      frontier,
      opts.kinds,
      opts.ceiling,
      limit + 1,
    );
    const next: string[] = [];
    const frontierNodes = new Set(frontier);
    for (const edge of available) {
      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      if (result.length === limit) {
        truncated = true;
        break;
      }
      result.push(edge);
      const adjacent = frontierNodes.has(edge.src) ? edge.dst : edge.src;
      if (!seenNodes.has(adjacent)) {
        seenNodes.add(adjacent);
        next.push(adjacent);
      }
    }
    frontier = next;
  }

  result.sort(
    (a, b) =>
      compareText(a.src, b.src) ||
      compareText(a.dst, b.dst) ||
      compareText(a.kind, b.kind),
  );
  return { id, edges: result, truncated };
}
