import type { Database } from "bun:sqlite";
import { listCanonPages } from "../vault/pages";
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
  rebuilt_at: string;
}

export interface NeighborOptions {
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
}

export interface NeighborResult {
  id: string;
  edges: GraphEdge[];
}

function withoutCodeSpans(body: string): string {
  let result = "";
  let delimiter = 0;

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "`") {
      const character = body[index] as string;
      result += delimiter === 0 || character === "\n" ? character : " ";
      continue;
    }

    let run = 1;
    while (body[index + run] === "`") run += 1;
    if (delimiter === 0) delimiter = run;
    else if (delimiter === run) delimiter = 0;
    result += " ".repeat(run);
    index += run - 1;
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
      } else if (pair === "]]" ) {
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

export function rebuildGraph(
  db: Database,
  vaultPath: string,
): GraphRebuildResult {
  initGraph(db);
  const pages = listCanonPages(vaultPath);
  const rebuiltAt = new Date().toISOString();

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

    const edgeCount =
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM graph_edges",
        )
        .get()?.count ?? 0;
    db.query<never, [string, string, number]>(
      `INSERT INTO derived_meta (layer, rebuilt_at, doc_count)
       VALUES (?, ?, ?)
       ON CONFLICT (layer) DO UPDATE SET
         rebuilt_at = excluded.rebuilt_at,
         doc_count = excluded.doc_count`,
    ).run("graph", rebuiltAt, edgeCount);
  }).immediate();

  const edges =
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM graph_edges").get()
      ?.count ?? 0;
  return { pages: pages.length, edges, rebuilt_at: rebuiltAt };
}

function graphEdges(
  db: Database,
  kinds: GraphEdgeKind[] | undefined,
): GraphEdge[] {
  if (kinds?.length === 0) return [];
  if (kinds === undefined) {
    return db
      .query<GraphEdge, []>(
        "SELECT src, dst, kind FROM graph_edges ORDER BY src, dst, kind",
      )
      .all();
  }
  const slots = new Array<string>(kinds.length).fill("?").join(", ");
  return db
    .query<GraphEdge, GraphEdgeKind[]>(
      `SELECT src, dst, kind FROM graph_edges
       WHERE kind IN (${slots}) ORDER BY src, dst, kind`,
    )
    .all(...kinds);
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

  const available = graphEdges(db, opts.kinds);
  const seenNodes = new Set([id]);
  const seenEdges = new Set<string>();
  const result: GraphEdge[] = [];
  let frontier = new Set([id]);

  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of available) {
      const fromSource = frontier.has(edge.src);
      const fromDestination = frontier.has(edge.dst);
      if (!fromSource && !fromDestination) continue;

      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        result.push(edge);
      }
      const adjacent = fromSource ? edge.dst : edge.src;
      if (!seenNodes.has(adjacent)) next.add(adjacent);
    }
    for (const node of next) seenNodes.add(node);
    frontier = next;
  }

  result.sort(
    (a, b) =>
      a.src.localeCompare(b.src) ||
      a.dst.localeCompare(b.dst) ||
      a.kind.localeCompare(b.kind),
  );
  return { id, edges: result };
}
