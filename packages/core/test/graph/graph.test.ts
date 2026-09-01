import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { neighbors, rebuildGraph } from "../../src/graph/graph";
import type { GraphEdge } from "../../src/graph/graph";
import { initGraph } from "../../src/graph/schema";
import { serializePage } from "../../src/vault/frontmatter";
import { tempVault } from "../search/helpers";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function vault(): string {
  const created = tempVault();
  disposers.push(created.dispose);
  return created.path;
}

function writeCanon(
  vaultPath: string,
  name: string,
  id: string,
  body: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(vaultPath, "facts", `${name}.md`),
    serializePage({
      data: {
        id,
        title: name,
        type: "fact",
        status: "active",
        sensitivity: "personal",
        ...extra,
      },
      body,
    }),
    "utf8",
  );
}

function edgeRows(db: Database): GraphEdge[] {
  return db
    .query<GraphEdge, []>(
      "SELECT src, dst, kind FROM graph_edges ORDER BY src, dst, kind",
    )
    .all();
}

describe("graph rebuild", () => {
  test("initGraph is idempotent", () => {
    const db = new Database(":memory:");
    initGraph(db);
    initGraph(db);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name IN ('graph_edges', 'derived_meta') ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
    ).toEqual(["derived_meta", "graph_edges"]);
  });

  test("extracts plain and aliased wikilinks", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "origin", "fact:origin", "See [[Target]] and [[Other|label]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Other", kind: "wikilink" },
      { src: "fact:origin", dst: "Target", kind: "wikilink" },
    ]);
  });

  test("ignores wikilinks in code spans and nested brackets", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(
      path,
      "origin",
      "fact:origin",
      "Keep [[Visible]]. Ignore `[[Inline]]`, ```[[Fenced]]```, and [[Outer [[Inner]]]].",
    );

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Visible", kind: "wikilink" },
    ]);
  });

  test("adds subject and source edges from frontmatter", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "origin", "fact:origin", "No links.", {
      subjects: ["person:ada", "person:grace"],
      sources: ["event:one"],
    });

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "event:one", kind: "source" },
      { src: "fact:origin", dst: "person:ada", kind: "subject" },
      { src: "fact:origin", dst: "person:grace", kind: "subject" },
    ]);
  });

  test("is idempotent and stamps the edge count", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "origin", "fact:origin", "[[Target]] [[Target]]");

    rebuildGraph(db, path);
    const result = rebuildGraph(db, path);

    expect(result).toMatchObject({ pages: 1, edges: 1 });
    expect(edgeRows(db)).toHaveLength(1);
    expect(
      db
        .query<{ layer: string; doc_count: number }, []>(
          "SELECT layer, doc_count FROM derived_meta WHERE layer = 'graph'",
        )
        .get(),
    ).toEqual({ layer: "graph", doc_count: 1 });
  });
});

describe("neighbors", () => {
  function linkedDb(): Database {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges VALUES ('a', 'b', 'wikilink');
      INSERT INTO graph_edges VALUES ('c', 'a', 'subject');
      INSERT INTO graph_edges VALUES ('b', 'd', 'source');
      INSERT INTO graph_edges VALUES ('d', 'e', 'wikilink');
    `);
    return db;
  }

  test("returns incoming and outgoing edges at depth one", () => {
    expect(neighbors(linkedDb(), "a").edges).toEqual([
      { src: "a", dst: "b", kind: "wikilink" },
      { src: "c", dst: "a", kind: "subject" },
    ]);
  });

  test("traverses both directions through depth two", () => {
    expect(neighbors(linkedDb(), "a", { depth: 2 }).edges).toEqual([
      { src: "a", dst: "b", kind: "wikilink" },
      { src: "b", dst: "d", kind: "source" },
      { src: "c", dst: "a", kind: "subject" },
    ]);
  });

  test("filters traversal by edge kind", () => {
    expect(
      neighbors(linkedDb(), "a", { depth: 2, kinds: ["wikilink"] }).edges,
    ).toEqual([{ src: "a", dst: "b", kind: "wikilink" }]);
  });

  test("returns an empty envelope for an unknown id", () => {
    expect(neighbors(linkedDb(), "missing", { depth: 2 })).toEqual({
      id: "missing",
      edges: [],
    });
  });
});
