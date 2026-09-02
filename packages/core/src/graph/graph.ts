import type { Database } from "bun:sqlite";
import { stampDerived } from "../derived-meta";
import { placeholders, validLimit } from "../query/sql";
import { compareCodePoints } from "../util/text";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import type { SkippedPage } from "../vault/pages";
import { initGraph } from "./schema";

export type GraphEdgeKind = "wikilink" | "subject" | "source";

export interface GraphEdge {
  src: string;
  dst: string;
  kind: GraphEdgeKind;
}

export interface GraphRebuildResult {
  pages: number;
  edges: number;
  skipped: SkippedPage[];
  rebuilt_at: string;
}

export interface NeighborOptions {
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
  limit?: number;
}

export interface NeighborResult {
  id: string;
  edges: GraphEdge[];
  truncated: boolean;
}

const DEFAULT_NEIGHBOR_LIMIT = 1000;
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

export function rebuildGraph(
  db: Database,
  vaultPath: string,
): GraphRebuildResult {
  initGraph(db);
  const { pages, skipped } = listCanonPagesReport(vaultPath);
  const rebuiltAt = new Date().toISOString();
  let edges = 0;

  db.transaction(() => {
    db.exec("DELETE FROM graph_edges");
    const insert = db.query<never, [string, string, GraphEdgeKind]>(
      "INSERT OR IGNORE INTO graph_edges (src, dst, kind) VALUES (?, ?, ?)",
    );
    for (const page of pages) {
      for (const target of wikilinks(page.body)) {
        insert.run(page.id, target, "wikilink");
      }
      for (const subject of stringArray(page.data["subjects"])) {
        insert.run(page.id, subject, "subject");
      }
      for (const source of stringArray(page.data["sources"])) {
        insert.run(page.id, source, "source");
      }
    }

    edges =
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM graph_edges",
        )
        .get()?.count ?? 0;
    stampDerived(db, "graph", rebuiltAt, edges);
  }).immediate();

  return { pages: pages.length, edges, skipped, rebuilt_at: rebuiltAt };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * One frontier chunk, capped in SQL. `budget` is `limit + 1` for the whole
 * call rather than the count still outstanding: only edges already collected
 * can repeat inside a chunk, so `limit + 1` rows always carry every new edge
 * the caller still has room for. The cap is what keeps the work proportional
 * to `limit` instead of to the degree of the node.
 */
function incidentChunk(
  db: Database,
  ids: string[],
  kinds: GraphEdgeKind[] | undefined,
  budget: number,
): GraphEdge[] {
  const idSlots = placeholders(ids.length);
  const bindings: (string | number)[] = [...ids, ...ids];
  let kindClause = "";
  if (kinds !== undefined) {
    kindClause = ` AND kind IN (${placeholders(kinds.length)})`;
    bindings.push(...kinds);
  }
  bindings.push(budget);
  return db
    .query<GraphEdge, (string | number)[]>(
      `SELECT src, dst, kind FROM graph_edges
       WHERE (src IN (${idSlots}) OR dst IN (${idSlots}))${kindClause}
       ORDER BY src, dst, kind
       LIMIT ?`,
    )
    .all(...bindings);
}

/** Injective, so two distinct edges never collapse into one seen key. */
function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.src, edge.dst, edge.kind]);
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
  const limit = validLimit(opts.limit ?? DEFAULT_NEIGHBOR_LIMIT, "neighbors");
  if (opts.kinds?.length === 0) {
    return { id, edges: [], truncated: false };
  }

  // One edge past the cap is what proves truncation, so even a limit of 0
  // probes for a single adjacent edge instead of reporting a clean envelope.
  const ceiling = limit + 1;
  const seenNodes = new Set([id]);
  const seenEdges = new Set<string>();
  const collected: GraphEdge[] = [];
  let frontier = new Set([id]);

  for (let level = 0; level < depth && collected.length < ceiling; level += 1) {
    const next = new Set<string>();
    for (const group of chunks([...frontier], FRONTIER_CHUNK)) {
      if (collected.length >= ceiling) break;
      for (const edge of incidentChunk(db, group, opts.kinds, ceiling)) {
        const key = edgeKey(edge);
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        collected.push(edge);
        const adjacent = frontier.has(edge.src) ? edge.dst : edge.src;
        if (!seenNodes.has(adjacent)) {
          seenNodes.add(adjacent);
          next.add(adjacent);
        }
        if (collected.length >= ceiling) break;
      }
    }
    frontier = next;
  }

  const edges = collected.slice(0, limit);
  edges.sort(
    (a, b) =>
      compareCodePoints(a.src, b.src) ||
      compareCodePoints(a.dst, b.dst) ||
      compareCodePoints(a.kind, b.kind),
  );
  return { id, edges, truncated: collected.length > limit };
}
