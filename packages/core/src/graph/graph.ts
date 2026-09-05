import { canonAuthorities } from "../canon/authority";
import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { readDerivedMeta, stampDerived } from "../derived-meta";
import type { DerivedStamp } from "../derived-meta";
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
  authorities?: ReadonlyMap<string,RetrievalAuthority>;
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
  let result = "";

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "`") {
      result += body[index] as string;
      continue;
    }

    let run = 1;
    while (body[index + run] === "`") run += 1;
    let closing = index + run;
    while (closing < body.length) {
      if (body[closing] !== "`") {
        closing += 1;
        continue;
      }
      let closingRun = 1;
      while (body[closing + closingRun] === "`") closingRun += 1;
      if (closingRun === run) break;
      closing += closingRun;
    }
    if (closing >= body.length) {
      result += "`".repeat(run);
      index += run - 1;
      continue;
    }

    const end = closing + run;
    for (let cursor = index; cursor < end; cursor += 1) {
      result += body[cursor] === "\n" ? "\n" : " ";
    }
    index = end - 1;
  }

  return result;
}

function wikilinks(body: string): string[] {
  const source = withoutCodeSpans(body);
  const targets: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source.slice(index, index + 2) !== "[[") continue;
    const contentStart = index + 2;
    let cursor = contentStart;
    let depth = 1;
    let nested = false;

    while (cursor < source.length && depth > 0) {
      const pair = source.slice(cursor, cursor + 2);
      if (pair === "[[") {
        nested = true;
        depth += 1;
        cursor += 2;
      } else if (pair === "]]") {
        depth -= 1;
        if (depth > 0) cursor += 2;
      } else {
        cursor += 1;
      }
    }

    if (depth !== 0) continue;
    if (!nested) {
      const content = source.slice(contentStart, cursor);
      const target = (content.split("|", 1)[0] ?? "").trim();
      if (target.length > 0) targets.push(target);
    }
    index = cursor + 1;
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

/** Project every live page's edges. Same write as a graph rebuild. */
export function replacePageEdges(
  db: Database,
  pages: readonly CanonPage[],
  authorities = canonAuthorities(db,pages),
): void {
  const live = pages.filter(isLiveCanonPage);
  const index = linkIndexFromPages(pages);
  const byId = new Map(live.map((page) => [page.id, page]));
  const eventHints = eventSensitivityHints(db, sourceEventIds(live));
  db.exec("DELETE FROM graph_edges");
  for (const page of live) {
    for (const edge of pageEdges(page, index, byId, eventHints, authorities.get(page.relPath)??"model_inference")) {
      insertEdge(db, edge);
    }
  }
}

function stampGraphIncomplete(db: Database, skippedCount: number): void {
  const existing = readDerivedMeta(db, "graph");
  stampDerived(db, {
    layer: "graph",
    generation: existing?.generation ?? ulid(),
    rebuilt_at: new Date().toISOString(),
    doc_count: existing?.doc_count ?? 0,
    source_count: existing?.source_count ?? 0,
    skipped_count: skippedCount,
    status: "degraded",
    ledger_watermark: existing?.ledger_watermark ?? null,
    canon_hash: existing?.canon_hash ?? null,
    port_id: existing?.port_id ?? null,
    contract: existing?.contract ?? null,
    space: existing?.space ?? null,
  });
}

function restoreGraphStamp(db: Database, pages: readonly CanonPage[]): void {
  const existing = readDerivedMeta(db, "graph");
  if (existing === null || existing.status === "ok") return;
  const live = pages.filter(isLiveCanonPage);
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
 * page keeps its edges until the next complete walk.
 */
export function refreshPageEdges(
  db: Database,
  page: CanonPage,
  pages: readonly CanonPage[],
  skipped: number,
  authorities = canonAuthorities(db,pages),
): void {
  if (skipped === 0) {
    replacePageEdges(db, pages,authorities);
    restoreGraphStamp(db, pages);
    return;
  }
  const index = linkIndexFromPages(pages);
  const byId = new Map(
    pages.filter(isLiveCanonPage).map((candidate) => [candidate.id, candidate]),
  );
  db.query("DELETE FROM graph_edges WHERE src = ?").run(page.id);
  if (isLiveCanonPage(page)) {
    const eventHints = eventSensitivityHints(db, sourceEventIds([page]));
    for (const edge of pageEdges(page, index, byId, eventHints, authorities.get(page.relPath)??"model_inference")) {
      insertEdge(db, edge);
    }
  }
  stampGraphIncomplete(db, skipped);
}

/** Incremental delete. Incomplete walks only drop this page's outgoing edges. */
export function removePageEdges(
  db: Database,
  pageId: string,
  pages: readonly CanonPage[],
  skipped: number,
): void {
  if (skipped === 0) {
    replacePageEdges(db, pages);
    restoreGraphStamp(db, pages);
    return;
  }
  db.query("DELETE FROM graph_edges WHERE src = ?").run(pageId);
  stampGraphIncomplete(db, skipped);
}

function stampGraph(
  db: Database,
  input: GraphRebuildInput,
  pages: number,
  edges: number,
): DerivedStamp {
  const watermark = latestLedgerCursor(db);
  return {
    layer: "graph",
    generation: input.generation,
    rebuilt_at: input.rebuilt_at,
    doc_count: edges,
    source_count: pages,
    skipped_count: input.skipped.length,
    status: input.skipped.length > 0 ? "degraded" : "ok",
    ledger_watermark:
      watermark === null
        ? null
        : `${watermark.accepted_at}\t${watermark.event_id}`,
    canon_hash: input.canon_hash,
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
    pages: live,
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
  const live = input.pages.filter(isLiveCanonPage);
  replacePageEdges(db, live,input.authorities===undefined?canonAuthorities(db,live):new Map(input.authorities));
  const edges =
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM graph_edges",
      )
      .get()?.count ?? 0;
  stampDerived(db, stampGraph(db, input, live.length, edges));
  return {
    pages: live.length,
    edges,
    skipped: [...input.skipped],
    rebuilt_at: input.rebuilt_at,
    generation: input.generation,
    status: input.skipped.length > 0 ? "degraded" : "ok",
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
    for (const edge of available) {
      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      if (result.length === limit) {
        truncated = true;
        break;
      }
      result.push(edge);
      const adjacent = frontier.includes(edge.src) ? edge.dst : edge.src;
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
