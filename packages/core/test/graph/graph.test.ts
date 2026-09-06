import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDerivedPage } from "../../src/derived";
import { neighbors, rebuildGraph } from "../../src/graph/graph";
import type { GraphEdge } from "../../src/graph/graph";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import type { FrontmatterValue } from "../../src/contracts/proposal";
import { recordedPage } from "../helpers/recorded-page";
import { validEvent } from "../fixtures";
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

async function writeCanon(
  db: Database,
  vaultPath: string,
  name: string,
  id: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<string[]> {
  const data = {
    id,
    title: name,
    type: "fact",
    status: "active",
    sensitivity: "personal",
    taint: "clean",
    ...extra,
  };
  const relPath = `facts/${name}.md`;
  if (data.status !== "active") {
    writeFileSync(join(vaultPath, relPath), serializePage({ data, body }), "utf8");
    return [];
  }
  return (await recordedPage(db, vaultPath, relPath, data as Record<string, FrontmatterValue>, body)).sourceIds;
}

/** Topology assertions exclude the now-required source edge; metadata tests check it separately. */
function edgeRows(db: Database, kind: GraphEdge["kind"] | null = "wikilink"): GraphEdge[] {
  return db
    .query<GraphEdge, []>(
      "SELECT src, dst, kind FROM graph_edges ORDER BY src, dst, kind",
    )
    .all().filter(edge => kind === null || edge.kind === kind);
}

describe("graph rebuild", () => {
  test("initGraph is idempotent", () => {
    const db = openLedger(":memory:");
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

  test("extracts plain and aliased wikilinks", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "origin", "fact:origin", "See [[Target]] and [[Other|label]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Other", kind: "wikilink" },
      { src: "fact:origin", dst: "Target", kind: "wikilink" },
    ]);
  });

  test("ignores wikilinks in code spans and nested brackets", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(
      db,
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

  test("does not treat an unmatched backtick as a code span", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "origin", "fact:origin", "Unmatched ` then [[Visible]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Visible", kind: "wikilink" },
    ]);
  });

  test("resolves a unique wikilink title to the page id", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "target", "fact:target", "Destination.", { title: "Target" });
    await writeCanon(db, path, "origin", "fact:origin", "See [[Target]] and [[Missing]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Missing", kind: "wikilink" },
      { src: "fact:origin", dst: "fact:target", kind: "wikilink" },
    ]);
  });

  test("leaves an ambiguous title unresolved", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "garden", "fact:garden", "Garden.", { title: "Tea" });
    await writeCanon(db, path, "cupboard", "fact:cupboard", "Cupboard.", { title: "Tea" });
    await writeCanon(db, path, "origin", "fact:origin", "See [[Tea]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "Tea", kind: "wikilink" },
    ]);
  });

  test("leaves an ambiguous basename unresolved", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "tea", "fact:garden-tea", "Garden tea.", {
      title: "Garden tea",
    });
    await recordedPage(db, path, "entities/tea.md", {
          id: "fact:cupboard-tea",
          title: "Cupboard tea",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
        }, "Cupboard tea.");
    await writeCanon(db, path, "origin", "fact:origin", "See [[tea]] and [[facts/tea]].");

    rebuildGraph(db, path);

    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "fact:garden-tea", kind: "wikilink" },
      { src: "fact:origin", dst: "tea", kind: "wikilink" },
    ]);
  });

  test("stores sensitivity and provenance on every edge", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    const source = storedEvent(db, "origin-metadata", { text: "The synthetic record observes Target.", sensitivity_hint: "private" });
    await writeCanon(db, path, "origin", "fact:origin", "See [[Target]].", {
      sensitivity: "private",
      taint: "quoted",
      sources: [source.event_id],
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
      provenance: JSON.stringify([source.event_id]),
    });
    await writeCanon(db, path, "Target", "fact:target", "Dest.", { sensitivity: "personal" });
    rebuildGraph(db, path);
    expect(
      db
        .query<{ dest_sensitivity: string | null }, []>(
          "SELECT dest_sensitivity FROM graph_edges WHERE dst = 'fact:target'",
        )
        .get()?.dest_sensitivity,
    ).toBe("personal");
  });

  test("stores a source dest_sensitivity from the event hint", async () => {
    const db = searchDb();
    const path = vault();
    const hinted = storedEvent(db, "hinted", { sensitivity_hint: "private" });
    const input = { ...validEvent(), source_record_id: "unhinted", text: "A synthetic unhinted source record." };
    delete input.sensitivity_hint;
    const unhinted = accept(db, input);
    if (unhinted.status !== "stored") throw new Error("unhinted fixture capture was not stored");
    await writeCanon(db, path, "origin", "fact:origin", "No links.", {
      sources: [hinted.event_id, unhinted.event.event_id],
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
      { dst: hinted.event_id, dest_sensitivity: "private" },
      { dst: unhinted.event.event_id, dest_sensitivity: "unlabeled" },
    ]);
  });

  test("rebuild omits archived pages", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "live", "fact:live", "See [[Target]].");
    await writeCanon(db, path, "old", "fact:old", "See [[Target]].", { status: "archived" });
    expect(rebuildGraph(db, path).pages).toBe(1);
    expect(edgeRows(db).map(({ src }) => src)).toEqual(["fact:live"]);
  });

  test("hides private edges below a public ceiling", () => {
    const db = openLedger(":memory:");
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
    const db = openLedger(":memory:");
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
    const db = openLedger(":memory:");
    expect(neighbors(db, "hub")).toEqual({
      id: "hub",
      edges: [],
      truncated: false,
    });
  });

  test("adds subject and source edges from frontmatter", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    const sources = await writeCanon(db, path, "origin", "fact:origin", "No links.", {
      subjects: ["person:ada", "person:grace"],
    });

    rebuildGraph(db, path);

    expect(edgeRows(db, null)).toEqual([
      { src: "fact:origin", dst: sources[0]!, kind: "source" },
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
      { dest_sensitivity: "personal", kind: "source" },
      { dest_sensitivity: null, kind: "subject" },
      { dest_sensitivity: null, kind: "subject" },
    ]);
  });

  test("hidden source dests do not consume the neighbor cap", () => {
    const db = openLedger(":memory:");
    initGraph(db);
    // This isolates the bounded query over disposable rows. Admission tests
    // separately prove that a real page cannot lower its sources' floor.
    const insert = db.query(`INSERT INTO graph_edges
      (src,dst,kind,sensitivity,dest_sensitivity,taint,authority,provenance)
      VALUES ('fact:hub',?,?,'public',?,'clean','model_inference','[]')`);
    insert.run("fact:zzz-open", "wikilink", "public");
    for (let index = 0; index < 100; index += 1) insert.run(`event:aaa-secret-${index}`, "source", "private");

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

  test("is idempotent and stamps the edge count", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "origin", "fact:origin", "[[Target]] [[Target]]");

    rebuildGraph(db, path);
    const result = rebuildGraph(db, path);

    expect(result).toMatchObject({ pages: 1, edges: 2 });
    expect(edgeRows(db)).toHaveLength(1);
    expect(
      db
        .query<{ layer: string; doc_count: number; port_id: string | null }, []>(
          "SELECT layer, doc_count, port_id FROM derived_meta WHERE layer = 'graph'",
        )
        .get(),
    ).toEqual({ layer: "graph", doc_count: 2, port_id: null });
  });

  test("archiving a page drops incoming edges to its id", async () => {
    const db = openLedger(":memory:");
    const path = vault();
    await writeCanon(db, path, "target", "fact:target", "Destination.", { title: "Target" });
    await writeCanon(db, path, "origin", "fact:origin", "See [[Target]].");
    rebuildGraph(db, path);
    expect(edgeRows(db)).toEqual([
      { src: "fact:origin", dst: "fact:target", kind: "wikilink" },
    ]);

    await writeCanon(db, path, "target", "fact:target", "Destination.", {
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
