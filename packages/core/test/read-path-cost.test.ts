import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OWNER } from "../src/agents";
import { openLedger } from "../src/ledger/db";
import { eventFromRow, EventRecordError, type EventRow } from "../src/ledger/event-record";
import { accept } from "../src/ledger/ledger";
import { tableExists } from "../src/ledger/schema";
import { rebuildDerived } from "../src/derived";
import { initSearch } from "../src/search/schema";
import { searchAuditCandidates } from "../src/search/query";
import { readWorldView } from "../src/serving/world-view";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";
import { recordedPage } from "./helpers/recorded-page";
import { tempVault } from "./helpers/vault";
import { worldSeed } from "./helpers/world-seed";
import { setGrant } from "../src/agents";
import { serveSearch } from "../src/serving/search";
import type { ServeContext } from "../src/serving/types";
import { page, serveFixture } from "./serving/helpers";

describe("tableExists answers exactly as the catalog does", () => {
  test("agrees with the catalog for every kind of schema object", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE plain(a); CREATE VIEW seen AS SELECT 1; CREATE VIRTUAL TABLE words USING fts5(x);
      CREATE TABLE Mixed(a); CREATE INDEX plain_a ON plain(a); CREATE TRIGGER plain_t AFTER INSERT ON plain BEGIN SELECT 1; END;
      CREATE TEMP TABLE scratch(a)`);
    const catalog = (name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
    const names = ["plain", "seen", "words", "words_data", "words_config", "Mixed", "mixed", "plain_a", "plain_t", "scratch", "sqlite_master", "sqlite_schema", "absent"];
    for (const round of [1, 2]) for (const name of names) expect([round, name, tableExists(db, name)]).toEqual([round, name, catalog(name)]);
    db.close();
  });

  test("a table another connection creates or drops is seen on the next call", () => {
    const vault = tempVault("kizuki-table-memo-");
    const path = join(vault.path, "memo.db");
    const reader = new Database(path), writer = new Database(path);
    try {
      expect(tableExists(reader, "later")).toBe(false);
      writer.exec("CREATE TABLE later(a)");
      expect(tableExists(reader, "later")).toBe(true);
      writer.exec("DROP TABLE later");
      expect(tableExists(reader, "later")).toBe(false);
      reader.exec("CREATE TABLE own(a)");
      expect(tableExists(reader, "own")).toBe(true);
      reader.exec("DROP TABLE own");
      expect(tableExists(reader, "own")).toBe(false);
    } finally { reader.close(); writer.close(); vault.dispose(); }
  });

  test("a table created and rolled back inside a transaction is absent afterwards", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE kept(a)");
    expect(tableExists(db, "undone")).toBe(false);
    db.exec("BEGIN");
    db.exec("CREATE TABLE undone(a)");
    expect(tableExists(db, "undone")).toBe(true);
    db.exec("ROLLBACK");
    expect(tableExists(db, "undone")).toBe(false);
    expect(tableExists(db, "kept")).toBe(true);
    db.close();
  });
});

describe("a stored event row is validated again whenever any column differs", () => {
  function storedRow(db: Database, text: string): EventRow {
    const accepted = accept(db, { ...validEvent(), source_record_id: ulid(), text });
    if (accepted.status !== "stored") throw new Error("synthetic event was not stored");
    return db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id=?").get(accepted.event.event_id)!;
  }

  test("a second read of an unchanged row gives an equal event in a fresh outer object", () => {
    const db = openLedger(":memory:");
    try {
      const row = storedRow(db, "synthetic repeated read");
      const first = eventFromRow(row, db);
      (first as { kind: string }).kind = "mutated by a caller";
      const second = eventFromRow({ ...row }, db);
      expect(second.kind).toBe(row.kind);
      expect(second).toEqual(eventFromRow(row, db));
      expect(second).not.toBe(eventFromRow(row, db));
      expect(Object.isFrozen(second.subjects)).toBe(true);
    } finally { db.close(); }
  });

  test.each([
    ["text", "synthetic tampered text"],
    ["metadata", "{\"thread\":\"other\"}"],
    ["content_hash", "0".repeat(64)],
    ["accepted_at", "2026-01-01T00:00:00.000Z"],
    ["origin_binding", "1".repeat(64)],
  ] as const)("a row whose %s changed after a valid read is refused", (column, value) => {
    const db = openLedger(":memory:");
    try {
      const row = storedRow(db, "synthetic original text");
      expect(eventFromRow(row, db).event_id).toBe(row.event_id);
      expect(() => eventFromRow({ ...row, [column]: value }, db)).toThrow(EventRecordError);
      expect(eventFromRow(row, db).text).toBe("synthetic original text");
    } finally { db.close(); }
  });
});

test("one statement reads the ranked windows an offset would page through", async () => {
  const vault = tempVault("kizuki-search-windows-");
  const db = openLedger(":memory:");
  try {
    initSearch(db);
    for (let n = 1; n <= 7; n++) {
      await recordedPage(db, vault.path, `facts/${n}.md`, {
        id: `fact:${n}`, type: "fact", title: `Window ${n}`, status: "active", sensitivity: "public", taint: "clean",
      }, `windowed ${"windowed ".repeat(n)}synthetic`);
    }
    rebuildDerived(db, vault.path);
    const statements: string[] = [];
    const readDb = { query: (sql: string) => { statements.push(sql); return db.query(sql); } } as typeof db;
    const paged = [0, 2, 4, 6].flatMap(offset => searchAuditCandidates(db, "windowed", { scope: "canon", limit: 2, offset }).candidates);
    expect(paged).toHaveLength(7);
    const windowed = searchAuditCandidates(readDb, "windowed", { scope: "canon", limit: 2, windows: 4 });
    expect(windowed.candidates).toEqual(paged);
    expect(statements.filter(sql => sql.includes("search_docs MATCH"))).toHaveLength(1);
    expect(searchAuditCandidates(db, "windowed", { scope: "canon", limit: 2, windows: 2 }).candidates).toEqual(paged.slice(0, 4));
    for (const windows of [0, 1.5, 6]) expect(() => searchAuditCandidates(db, "windowed", { scope: "canon", limit: 2, windows })).toThrow(RangeError);
  } finally { db.close(); vault.dispose(); }
});

test("world reads never let the claims table lead their statements", async () => {
  const vault = tempVault("kizuki-world-plan-");
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const seeded = await worldSeed(db);
    const statements = new Set<string>();
    const recording = new Proxy(db, {
      get(target, key) {
        if (key === "query") return (sql: string) => { statements.add(sql); return target.query(sql); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = { db: recording, vaultPath: vault.path, principal: OWNER };
    const at = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
    readWorldView(ctx, { operation: "concept", concept: seeded.ref, ...at });
    readWorldView(ctx, { operation: "find_concepts", label: "Bayesian", ...at });
    const world = [...statements].filter(sql => /FROM claim_v2_semantics c (CROSS )?JOIN claims base|FROM semantic_bindings b (CROSS )?JOIN claim_v2_semantics c/.test(sql));
    // The identity walk, the member collector, the discovery scan and its label read.
    expect(world.filter(sql => sql.includes("concept.same_as")).length).toBeGreaterThan(0);
    expect(world.filter(sql => sql.includes("GROUP BY b.handle_id")).length).toBeGreaterThan(0);
    expect(world.filter(sql => sql.includes("json_extract(payload,'$.object.ref.kind')=?")).length).toBeGreaterThan(0);
    for (const sql of world) {
      const steps = db.query<{ parent: number; detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().filter(step => step.parent === 0);
      const base = steps.filter(step => /^(SCAN|SEARCH) base\b/.test(step.detail));
      expect([sql.slice(0, 120), base.map(step => step.detail)]).toEqual([sql.slice(0, 120), base.map(() => "SEARCH base USING INDEX sqlite_autoindex_claims_1 (claim_id=?)")]);
    }
  } finally { db.close(); vault.dispose(); }
});

describe("nothing proved for one read is served by the next once it changed", () => {
  async function served(ctx: ServeContext): Promise<Map<string, string>> {
    const envelope = await serveSearch(ctx, { query: "kettle" });
    return new Map(envelope.canon.map(chunk => [chunk.page_id, chunk.excerpt]));
  }

  test("a page edited on disk between two reads", async () => {
    const fixture = await serveFixture();
    try {
      const before = await served(fixture.owner());
      expect(before.get("person:ada")).toContain("Ada keeps the kettle warm.");
      page(fixture.vaultPath, "entities/person-ada.md", {
        sources: [Object.values(fixture.events)[0]!], id: "person:ada", title: "Ada", type: "person",
        status: "active", sensitivity: "public", taint: "clean", subjects: ["person:ada"],
      }, "Ada keeps the kettle warm and an unrecorded kettle edit.");
      const after = await served(fixture.owner());
      expect(after.has("person:ada")).toBe(false);
      expect(before.get("person:grace")).toContain("Grace reviews the kettle log.");
      expect(after.get("person:grace")).toBe(before.get("person:grace")!);
    } finally { fixture.dispose(); }
  }, 60_000);

  test("a page whose receipt was replaced between two reads", async () => {
    const fixture = await serveFixture();
    try {
      expect((await served(fixture.owner())).get("person:grace")).toContain("Grace reviews the kettle log.");
      // The recorded revision now names other bytes; the page on disk is unchanged.
      fixture.db.query("UPDATE canon_receipts SET after_hash=? WHERE page_path=?").run("0".repeat(64), "entities/person-grace.md");
      const after = await served(fixture.owner());
      expect(after.has("person:grace")).toBe(false);
      expect(after.get("person:ada")).toContain("Ada keeps the kettle warm.");
    } finally { fixture.dispose(); }
  }, 60_000);

  test("a reader whose scope narrowed between two reads", async () => {
    const fixture = await serveFixture();
    try {
      expect((await served(fixture.agent("reader-private"))).has("fact:kettle")).toBe(true);
      setGrant(fixture.db, "reader-private", { ceiling: "public" });
      const after = await served(fixture.agent("reader-private"));
      expect(after.has("fact:kettle")).toBe(false);
      expect(after.has("person:grace")).toBe(false);
      expect(after.has("person:ada")).toBe(true);
    } finally { fixture.dispose(); }
  }, 60_000);
});
