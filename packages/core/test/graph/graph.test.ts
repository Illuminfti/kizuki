import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDerivedPage } from "../../src/derived";
import { neighbors, rebuildGraph } from "../../src/graph/graph";
import type { GraphEdge } from "../../src/graph/graph";
import { initGraph } from "../../src/graph/schema";
import { serializePage } from "../../src/vault/frontmatter";
import { searchDb, storedEvent, tempVault } from "../search/helpers";

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
        taint: "clean",
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

  test("does not treat an unmatched backtick as a code span", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "origin", "fact:origin", "Unmatched ` then [[Visible]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Visible", kind: "wikilink" },
    ]);
  });

  test("resolves a unique wikilink title to the page id", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "target", "fact:target", "Destination.", { title: "Target" });
    writeCanon(path, "origin", "fact:origin", "See [[Target]] and [[Missing]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Missing", kind: "wikilink" },
      { src: "fact:origin", dst: "fact:target", kind: "wikilink" },
    ]);
  });

  test("leaves an ambiguous title unresolved", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "garden", "fact:garden", "Garden.", { title: "Tea" });
    writeCanon(path, "cupboard", "fact:cupboard", "Cupboard.", { title: "Tea" });
    writeCanon(path, "origin", "fact:origin", "See [[Tea]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Tea", kind: "wikilink" },
    ]);
  });

  test("leaves an ambiguous basename unresolved", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "tea", "fact:garden-tea", "Garden tea.", {
      title: "Garden tea",
    });
    writeFileSync(
      join(path, "entities", "tea.md"),
      serializePage({
        data: {
          id: "fact:cupboard-tea",
          title: "Cupboard tea",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
        },
        body: "Cupboard tea.",
      }),
      "utf8",
    );
    writeCanon(path, "origin", "fact:origin", "See [[tea]] and [[facts/tea]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "fact:garden-tea", kind: "wikilink" },
      { src: "fact:origin", dst: "tea", kind: "wikilink" },
    ]);
  });

  test("stores sensitivity and provenance on every edge", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "origin", "fact:origin", "See [[Target]].", {
      sensitivity: "private",
      taint: "quoted",
      sources: ["event:one"],
    });
    rebuildGraph(db, path);
    expect(
      db
        .query<
          { sensitivity: string; taint: string; provenance: string },
          []
        >(
          "SELECT sensitivity, taint, provenance FROM graph_edges",
        )
        .get(),
    ).toEqual({
      sensitivity: "private",
      taint: "quoted",
      provenance: '["event:one"]',
    });
    writeCanon(path, "Target", "fact:target", "Dest.", { sensitivity: "personal" });
    rebuildGraph(db, path);
    expect(
      db
        .query<{ dest_sensitivity: string | null }, []>(
          "SELECT dest_sensitivity FROM graph_edges WHERE dst = 'fact:target'",
        )
        .get()?.dest_sensitivity,
    ).toBe("personal");
  });

  test("stores a source dest_sensitivity from the event hint", () => {
    const db = searchDb();
    const path = vault();
    const hinted = storedEvent(db, "hinted", { sensitivity_hint: "private" });
    writeCanon(path, "origin", "fact:origin", "No links.", {
      sources: [`event:${hinted.event_id}`, "event:missing"],
    });
    rebuildGraph(db, path);
    expect(
      db
        .query<{ dst: string; dest_sensitivity: string | null }, []>(
          `SELECT dst, dest_sensitivity FROM graph_edges
            WHERE kind = 'source' ORDER BY dst`,
        )
        .all(),
    ).toEqual([
      { dst: `event:${hinted.event_id}`, dest_sensitivity: "private" },
      { dst: "event:missing", dest_sensitivity: "unlabeled" },
    ]);
  });

  test("rebuild omits archived pages", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "live", "fact:live", "See [[Target]].");
    writeCanon(path, "old", "fact:old", "See [[Target]].", { status: "archived" });
    expect(rebuildGraph(db, path).pages).toBe(1);
    expect(edgeRows(db).map(({ src }) => src)).toEqual(["fact:live"]);
  });

  test("hides private edges below a public ceiling", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('hub', 'secret', 'subject', 'private', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('hub', 'open', 'subject', 'public', 'clean', 'owner_authored', '[]');
    `);
    expect(neighbors(db, "hub", { ceiling: "public" }).edges.map(({ dst }) => dst)).toEqual([
      "open",
    ]);
  });

  test("hides a resolved dest above the ceiling without consuming the cap", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges (src, dst, kind, sensitivity, dest_sensitivity, taint, authority, provenance)
      VALUES ('hub', 'secret', 'wikilink', 'public', 'private', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, dest_sensitivity, taint, authority, provenance)
      VALUES ('hub', 'open', 'wikilink', 'public', 'public', 'clean', 'owner_authored', '[]');
    `);
    expect(neighbors(db, "hub", { ceiling: "public" }).edges.map(({ dst }) => dst)).toEqual([
      "open",
    ]);
  });

  test("a missing graph table is an empty walk", () => {
    const db = new Database(":memory:");
    expect(neighbors(db, "hub")).toEqual({
      id: "hub",
      edges: [],
      truncated: false,
    });
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
    expect(
      db
        .query<{ dest_sensitivity: string | null; kind: string }, []>(
          "SELECT dest_sensitivity, kind FROM graph_edges ORDER BY kind, dst",
        )
        .all(),
    ).toEqual([
      { dest_sensitivity: "unlabeled", kind: "source" },
      { dest_sensitivity: null, kind: "subject" },
      { dest_sensitivity: null, kind: "subject" },
    ]);
  });

  test("hidden source dests do not consume the neighbor cap", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "open", "fact:zzz-open", "A public dest.", {
      title: "Open",
      sensitivity: "public",
    });
    writeCanon(
      path,
      "hub",
      "fact:hub",
      "See [[Open]].",
      {
        sensitivity: "public",
        sources: Array.from(
          { length: 100 },
          (_value, index) => `event:aaa-secret-${index}`,
        ),
      },
    );
    rebuildGraph(db, path);

    const limited = neighbors(db, "fact:hub", { ceiling: "public" });
    expect(limited.edges).toEqual([
      { src: "fact:hub", dst: "fact:zzz-open", kind: "wikilink" },
    ]);
    expect(limited.truncated).toBe(false);

    const uncapped = neighbors(db, "fact:hub");
    expect(uncapped.edges).toHaveLength(100);
    expect(uncapped.truncated).toBe(true);
    expect(uncapped.edges.every((edge) => edge.kind === "source")).toBe(true);
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
        .query<{ layer: string; doc_count: number; port_id: string | null }, []>(
          "SELECT layer, doc_count, port_id FROM derived_meta WHERE layer = 'graph'",
        )
        .get(),
    ).toEqual({ layer: "graph", doc_count: 1, port_id: null });
  });

  test("archiving a page drops incoming edges to its id", () => {
    const db = new Database(":memory:");
    const path = vault();
    writeCanon(path, "target", "fact:target", "Destination.", { title: "Target" });
    writeCanon(path, "origin", "fact:origin", "See [[Target]].");
    rebuildGraph(db, path);
    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "fact:target", kind: "wikilink" },
    ]);

    writeCanon(path, "target", "fact:target", "Destination.", {
      title: "Target",
      status: "archived",
    });
    removeDerivedPage(db, "fact:target", path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Target", kind: "wikilink" },
    ]);
  });
});

describe("neighbors", () => {
  function linkedDb(): Database {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('a', 'b', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('c', 'a', 'subject', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('b', 'd', 'source', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('d', 'e', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
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
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('a', 'b', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('x', 'y', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
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
      `INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
       VALUES (?, ?, ?, 'public', 'clean', 'owner_authored', '[]')`,
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
  });

  test("rejects a limit above MAX_RETRIEVAL_LIMIT", () => {
    expect(() => neighbors(linkedDb(), "a", { limit: 101 })).toThrow(RangeError);
  });

  test("a depth-two walk fills the cap and reports leftover edges", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('a', 'b', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('b', 'c', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('b', 'd', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('b', 'e', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
    `);
    const limited = neighbors(db, "a", { depth: 2, limit: 2 });
    expect(limited.edges).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(neighbors(db, "a", { depth: 2, limit: 4 }).truncated).toBe(false);
  });

  test("orders edges by code point, not locale", () => {
    const db = new Database(":memory:");
    initGraph(db);
    db.exec(`
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('hub', 'a-node', 'subject', 'public', 'clean', 'owner_authored', '[]');
      INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
      VALUES ('hub', 'Z-node', 'subject', 'public', 'clean', 'owner_authored', '[]');
    `);
    expect(neighbors(db, "hub").edges.map(({ dst }) => dst)).toEqual([
      "Z-node",
      "a-node",
    ]);
  });
});
