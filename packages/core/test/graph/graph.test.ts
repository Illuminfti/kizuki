import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { neighbors, rebuildGraph } from "../../src/graph/graph";
import type { GraphEdge } from "../../src/graph/graph";
import { initGraph } from "../../src/graph/schema";
import { tempVault, writeCanon } from "../helpers/vault";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function vault(): string {
  const created = tempVault();
  disposers.push(created.dispose);
  return created.path;
}

function writeFact(
  vaultPath: string,
  name: string,
  id: string,
  body: string,
  extra: Record<string, unknown> = {},
): void {
  writeCanon(
    vaultPath,
    `facts/${name}.md`,
    {
      id,
      title: name,
      type: "fact",
      status: "active",
      sensitivity: "personal",
      ...extra,
    },
    body,
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
    writeFact(path, "origin", "fact:origin", "See [[Target]] and [[Other|label]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Other", kind: "wikilink" },
      { src: "fact:origin", dst: "Target", kind: "wikilink" },
    ]);
  });

  test("ignores wikilinks in code spans and nested brackets", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeFact(
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

  test("does not treat an unmatched backtick as a code span", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeFact(path, "origin", "fact:origin", "Unmatched ` then [[Visible]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Visible", kind: "wikilink" },
    ]);
  });

  test("adds subject and source edges from frontmatter", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeFact(path, "origin", "fact:origin", "No links.", {
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
    writeFact(path, "origin", "fact:origin", "[[Target]] [[Target]]");

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

  test("reports skipped pages and counts edges once", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeFact(path, "linked", "fact:linked", "[[Target]]", {
      subjects: ["person:ada"],
    });
    writeFileSync(join(path, "facts", "stray.md"), "no frontmatter here\n", "utf8");

    const result = rebuildGraph(db, path);

    expect(result.pages).toBe(1);
    expect(result.edges).toBe(edgeRows(db).length);
    expect(result.skipped).toEqual([
      {
        relPath: "facts/stray.md",
        kind: "unreadable",
        reason: "frontmatter must begin with an exact --- line",
      },
    ]);
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
    expect(neighbors(linkedDb(), "a")).toEqual({
      id: "a",
      truncated: false,
      edges: [
        { src: "a", dst: "b", kind: "wikilink" },
        { src: "c", dst: "a", kind: "subject" },
      ],
    });
  });

  test("traverses both directions through depth two", () => {
    expect(neighbors(linkedDb(), "a", { depth: 2 })).toEqual({
      id: "a",
      truncated: false,
      edges: [
        { src: "a", dst: "b", kind: "wikilink" },
        { src: "b", dst: "d", kind: "source" },
        { src: "c", dst: "a", kind: "subject" },
      ],
    });
  });

  test("filters traversal by edge kind", () => {
    expect(neighbors(linkedDb(), "a", { depth: 2, kinds: ["wikilink"] })).toEqual({
      id: "a",
      truncated: false,
      edges: [{ src: "a", dst: "b", kind: "wikilink" }],
    });
  });

  test("returns an empty envelope for an unknown id", () => {
    expect(neighbors(linkedDb(), "missing", { depth: 2 })).toEqual({
      id: "missing",
      edges: [],
      truncated: false,
    });
  });

  test("queries incident edges instead of loading the whole table", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges VALUES ('a', 'b', 'wikilink');
      INSERT INTO graph_edges VALUES ('x', 'y', 'wikilink');
    `);
    const select = db.query.bind(db);
    let scanned = 0;
    db.query = ((sql: string) => {
      if (sql.includes("FROM graph_edges") && !sql.includes("WHERE")) {
        scanned += 1;
      }
      return select(sql);
    }) as Database["query"];

    expect(neighbors(db, "a").edges).toEqual([
      { src: "a", dst: "b", kind: "wikilink" },
    ]);
    expect(scanned).toBe(0);
  });

  test("bounds fan-out and reports truncation", () => {
    const db = new Database(":memory:");
    initGraph(db);
    const insert = db.query<never, [string, string, string]>(
      "INSERT INTO graph_edges (src, dst, kind) VALUES (?, ?, ?)",
    );
    insert.run("hub", "Z-node", "subject");
    insert.run("hub", "a-node", "subject");
    for (let index = 0; index < 3; index += 1) {
      insert.run("hub", `n${index}`, "subject");
    }

    const limited = neighbors(db, "hub", { limit: 3 });
    expect(limited.truncated).toBe(true);
    expect(limited.edges).toHaveLength(3);
    expect(neighbors(db, "hub", { limit: 5 }).truncated).toBe(false);
    expect(() => neighbors(db, "hub", { limit: -1 })).toThrow(RangeError);
    // A zero limit still has to say that the node was under-served.
    expect(neighbors(db, "hub", { limit: 0 })).toEqual({
      id: "hub",
      edges: [],
      truncated: true,
    });
    expect(neighbors(db, "nobody", { limit: 0 })).toEqual({
      id: "nobody",
      edges: [],
      truncated: false,
    });
  });

  test("traverses a frontier larger than one chunk", () => {
    const db = new Database(":memory:");
    initGraph(db);
    const insert = db.query<never, [string, string, string]>(
      "INSERT INTO graph_edges (src, dst, kind) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 0; index < 1200; index += 1) {
        const leaf = `leaf-${String(index).padStart(4, "0")}`;
        insert.run("hub", leaf, "wikilink");
        insert.run(leaf, `tail-${String(index).padStart(4, "0")}`, "wikilink");
      }
    }).immediate();

    // Round two starts from 1200 frontier ids, so the reader has to chunk.
    const result = neighbors(db, "hub", { depth: 2, limit: 5000 });

    expect(result.truncated).toBe(false);
    expect(result.edges).toHaveLength(2400);
    expect(
      result.edges.filter(({ src }) => src.startsWith("leaf-")),
    ).toHaveLength(1200);
    expect(result.edges.at(-1)).toEqual({
      src: "leaf-1199",
      dst: "tail-1199",
      kind: "wikilink",
    });
  });

  test("reads no more rows than the limit, whatever the degree", () => {
    const db = new Database(":memory:");
    initGraph(db);
    const insert = db.query<never, [string, string, string]>(
      "INSERT INTO graph_edges (src, dst, kind) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 0; index < 5000; index += 1) {
        insert.run("hub", `leaf-${String(index).padStart(5, "0")}`, "wikilink");
      }
    }).immediate();

    const fetched: number[] = [];
    const select = db.query.bind(db);
    db.query = ((sql: string) => {
      const statement = select(sql);
      if (!sql.includes("FROM graph_edges")) return statement;
      const all = statement.all.bind(statement);
      statement.all = ((...args: never[]) => {
        const rows = all(...args) as unknown[];
        fetched.push(rows.length);
        return rows;
      }) as typeof statement.all;
      return statement;
    }) as Database["query"];

    const result = neighbors(db, "hub", { limit: 10 });

    expect(result.edges).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(fetched).toEqual([11]);
  });

  test("keeps two edges whose ids differ only where a joined key would not", () => {
    const db = new Database(":memory:");
    initGraph(db);
    const insert = db.query<never, [string, string, string]>(
      "INSERT INTO graph_edges (src, dst, kind) VALUES (?, ?, ?)",
    );
    insert.run("x", "a", "wikilink");
    insert.run("x", "a\u0000b", "wikilink");
    insert.run("a", "b\u0000c", "wikilink");
    insert.run("a\u0000b", "c", "wikilink");

    // The last two are distinct edges that share a NUL-joined key.
    expect(neighbors(db, "x", { depth: 2 }).edges).toHaveLength(4);
  });

  test("orders edges by code point, not locale", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges VALUES ('hub', 'a-node', 'subject');
      INSERT INTO graph_edges VALUES ('hub', 'Z-node', 'subject');
    `);
    expect(neighbors(db, "hub").edges.map(({ dst }) => dst)).toEqual([
      "Z-node",
      "a-node",
    ]);
  });
});
