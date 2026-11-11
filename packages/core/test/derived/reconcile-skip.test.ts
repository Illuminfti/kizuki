import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { reserveAudit } from "../../src/agents/audit";
import { RECONCILE_RECHECK_MS, reconcileDerivedPages, reconcileDerivedPagesWhenChanged } from "../../src/derived-refresh";
import { accept } from "../../src/ledger/ledger";
import { removeCanonPath } from "../../src/search/indexer";
import { openLedger } from "../../src/ledger/db";
import { serveSearch } from "../../src/serving/search";
import { validEvent } from "../fixtures";
import { STORED_ROWS_SQL, reconcileFixture, underForeignWriteLock, watchingQueries } from "./reconcile-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

/** Past the racy window, so files the test just wrote count as settled. */
const later = () => Date.now() + 5_000;
const refresh = (db: Database, vault: string, now = later()) => reconcileDerivedPagesWhenChanged(db, vault, now);

/**
 * A pass that wrote moved its own inputs, so the next one compares again. A
 * health stamp that turns the graph unhealthy takes one projection more.
 */
function settle(db: Database, vault: string): void {
  let passes = 0;
  while (passes < 4 && refresh(db, vault)) passes += 1;
  expect(passes).toBeLessThanOrEqual(3);
}

test("a refresh with nothing changed runs no pass and takes no write lock", async () => {
  const f = await reconcileFixture(cleanup);
  // The first pass compares every page and has only health stamps to write.
  expect(refresh(f.db, f.vault)).toBe(true);
  let compared = 0;
  const ran = underForeignWriteLock(f.db, f.other(), () =>
    watchingQueries(f.db, sql => { if (sql.includes(STORED_ROWS_SQL)) compared += 1; }, () => refresh(f.db, f.vault)));
  expect(ran).toBe(false);
  expect(compared).toBe(0);
  // A served call's audit row is a ledger write, and no input of a pass.
  reserveAudit(f.db, OWNER, "search", { query: "tea" });
  expect(refresh(f.db, f.vault)).toBe(false);
});

test("an edited, retimed, removed, renamed and added page each end the skip and reach the index", async () => {
  const f = await reconcileFixture(cleanup);
  const tea = join(f.vault, "facts/tea.md");
  const original = readFileSync(tea, "utf8");
  const recorded = statSync(tea, { bigint: true });
  // Gives the page back its recorded modification time, to the nanosecond.
  const reference = join(f.vault, ".kizuki/tea.md.times");
  copyFileSync(tea, reference);
  expect(Bun.spawnSync(["touch", "-r", tea, reference]).exitCode).toBe(0);
  const retime = () => {
    expect(Bun.spawnSync(["touch", "-r", reference, tea]).exitCode).toBe(0);
    const now = statSync(tea, { bigint: true });
    expect([now.size, now.mtimeNs]).toEqual([recorded.size, recorded.mtimeNs]);
  };
  settle(f.db, f.vault);

  // Same size and the same modification time, different bytes: the unreceipted revision leaves the index.
  writeFileSync(tea, original.replace("tea with", "TEA with"));
  retime();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md"]);
  settle(f.db, f.vault);

  // The receipted bytes restored under that same modification time bring it back.
  writeFileSync(tea, original);
  retime();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  settle(f.db, f.vault);

  // Touched and nothing else: compared again, and nothing to write.
  utimesSync(tea, new Date(), new Date());
  expect(underForeignWriteLock(f.db, f.other(), () => refresh(f.db, f.vault))).toBe(true);
  expect(refresh(f.db, f.vault)).toBe(false);

  // A modification time set far ahead is a change like any other, and vouches for nothing after it.
  utimesSync(tea, new Date(), new Date(Date.now() + 86_400_000));
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(refresh(f.db, f.vault)).toBe(false);

  // Removed.
  const aside = join(f.vault, ".kizuki/tea.md.aside");
  renameSync(tea, aside);
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md"]);
  settle(f.db, f.vault);

  // Added under another name: the receipt names the old path, so it stays out.
  renameSync(aside, join(f.vault, "facts/tea-moved.md"));
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md"]);
  settle(f.db, f.vault);

  // Renamed back.
  renameSync(join(f.vault, "facts/tea-moved.md"), tea);
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  settle(f.db, f.vault);

  // Deleted for good.
  unlinkSync(join(f.vault, "facts/kettle.md"));
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/tea.md"]);
});

test("a file changed within the racy window settles nothing", async () => {
  const f = await reconcileFixture(cleanup);
  settle(f.db, f.vault);
  writeFileSync(join(f.vault, "facts/tea.md"), readFileSync(join(f.vault, "facts/tea.md"), "utf8"));
  const now = Date.now();
  expect(refresh(f.db, f.vault, now)).toBe(true);
  // That pass could not vouch for the fresh file, so the next one runs too.
  expect(refresh(f.db, f.vault, now)).toBe(true);
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(refresh(f.db, f.vault)).toBe(false);
});

test("a clock set back and an elapsed recheck interval each run a pass", async () => {
  const f = await reconcileFixture(cleanup);
  const settledAt = Date.now() + 60_000;
  let passes = 0;
  while (passes < 4 && refresh(f.db, f.vault, settledAt)) passes += 1;
  expect(refresh(f.db, f.vault, settledAt + RECONCILE_RECHECK_MS - 1)).toBe(false);
  // Earlier than the pass it would trust, though every file is long settled.
  expect(refresh(f.db, f.vault, settledAt - 30_000)).toBe(true);
  expect(refresh(f.db, f.vault, settledAt - 30_000)).toBe(false);
  expect(refresh(f.db, f.vault, settledAt - 30_000 + RECONCILE_RECHECK_MS)).toBe(true);
  // Files that look newer than the clock yield no stamp at all.
  expect(refresh(f.db, f.vault, Date.now() - 60_000)).toBe(true);
  expect(refresh(f.db, f.vault, Date.now() - 60_000)).toBe(true);
});

test("a hold, a new event, a dropped index, a canon write and a changed stamp each end the skip", async () => {
  const f = await reconcileFixture(cleanup);
  settle(f.db, f.vault);
  f.db.query("INSERT INTO canon_holds VALUES (?, ?, ?, ?)").run("facts/tea.md", "synthetic-hold", "synthetic recovery", "2026-09-29T12:00:00.000Z");
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md"]);
  settle(f.db, f.vault);
  // The same hold changed in place moves no count.
  f.db.query("UPDATE canon_holds SET page_path='facts/kettle.md'").run();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/tea.md"]);
  f.db.query("DELETE FROM canon_holds").run();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  settle(f.db, f.vault);

  // Written by another connection.
  expect(accept(f.other(5_000), { ...validEvent(), connector_id: "fixture", source_record_id: "later-capture" }).status).toBe("stored");
  expect(refresh(f.db, f.vault)).toBe(true);
  settle(f.db, f.vault);

  f.db.exec("DROP TABLE search_docs");
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_docs WHERE scope='canon'").get()).toEqual({ n: 2 });
  settle(f.db, f.vault);

  // Every canon write advances the read generation, in place.
  f.db.query("UPDATE canon_read_generation SET generation=generation+1").run();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(refresh(f.db, f.vault)).toBe(false);

  const docs = f.db.query("SELECT doc_count FROM derived_meta WHERE layer='search'").get();
  f.db.query("UPDATE derived_meta SET doc_count=doc_count+1 WHERE layer='search'").run();
  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.db.query("SELECT doc_count FROM derived_meta WHERE layer='search'").get()).toEqual(docs);
});

test("no pass reads the run logs a skip ignores", async () => {
  const f = await reconcileFixture(cleanup);
  // Every kind of pass: one that restores the index, one that rewrites a page, one that finds nothing.
  f.db.exec("DROP TABLE search_docs");
  const statements: string[] = [];
  const watched = () => watchingQueries(f.db, sql => statements.push(sql), () => reconcileDerivedPages(f.db, f.vault));
  expect(watched()).toBe(true);
  removeCanonPath(f.db, "facts/tea.md");
  expect(watched()).toBe(true);
  while (watched()) { /* until a pass finds nothing to write */ }
  expect(statements.length).toBeGreaterThan(20);
  expect(statements.filter(sql => /\b(agent_audit|connection_runs|run_receipts)\b/.test(sql))).toEqual([]);
});

test("a stale projection no stamp can see is never served as current, and the recheck repairs it", async () => {
  const f = await reconcileFixture(cleanup);
  const at = later();
  let passes = 0;
  while (passes < 4 && refresh(f.db, f.vault, at)) passes += 1;
  const owner = { db: f.db, vaultPath: f.vault, principal: OWNER };
  expect((await serveSearch(owner, { query: "tea" })).data?.degraded ?? []).not.toContain("index-degraded");

  // Edited in place by hand: no file, count or rowid moves, so the refresh still skips.
  f.db.query("UPDATE search_documents SET path='facts/elsewhere.md' WHERE path='facts/tea.md'").run();
  expect(refresh(f.db, f.vault, at + 1)).toBe(false);
  // A reader proves the index against its own view of canon on every call.
  expect((await serveSearch(owner, { query: "tea" })).data?.degraded).toContain("index-degraded");
  expect(refresh(f.db, f.vault, at + RECONCILE_RECHECK_MS - 1)).toBe(false);

  expect(refresh(f.db, f.vault, at + RECONCILE_RECHECK_MS)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  expect((await serveSearch(owner, { query: "tea" })).data?.degraded ?? []).not.toContain("index-degraded");
});

test("a pass that fails midway writes nothing and settles nothing", async () => {
  const f = await reconcileFixture(cleanup);
  settle(f.db, f.vault);
  removeCanonPath(f.db, "facts/kettle.md");
  f.db.query("UPDATE search_documents SET title='stale' WHERE path='facts/tea.md'").run();
  const before = f.db.query("SELECT doc_id, title FROM search_documents WHERE scope='canon'").all();
  let inserts = 0;
  expect(() => watchingQueries(f.db, sql => {
    // The first rewritten page lands; the process dies writing the second.
    if (sql.includes("INSERT INTO search_docs (") && (inserts += 1) === 2) throw new Error("synthetic crash");
  }, () => refresh(f.db, f.vault))).toThrow("synthetic crash");
  expect(inserts).toBe(2);
  expect(f.db.query("SELECT doc_id, title FROM search_documents WHERE scope='canon'").all()).toEqual(before);

  expect(refresh(f.db, f.vault)).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  expect(f.db.query("SELECT title FROM search_documents WHERE path='facts/tea.md'").get()).toEqual({ title: "tea" });
});

test("a handle opened after a restart starts with a pass", async () => {
  const f = await reconcileFixture(cleanup);
  settle(f.db, f.vault);
  const restarted = openLedger(f.dbPath);
  cleanup.push(() => restarted.close());
  expect(refresh(restarted, f.vault)).toBe(true);
  expect(refresh(restarted, f.vault)).toBe(false);
  // What the first handle remembers is its own.
  expect(refresh(f.db, f.vault)).toBe(false);
});

test("a vault with an unreadable page settles with its graph degraded", async () => {
  const f = await reconcileFixture(cleanup);
  writeFileSync(join(f.vault, "facts/broken.md"), "---\nid: fact:broken\n---\nNo schema.");
  settle(f.db, f.vault);
  expect(f.db.query("SELECT status FROM derived_meta WHERE layer='graph'").get()).toEqual({ status: "degraded" });
  expect(underForeignWriteLock(f.db, f.other(), () => reconcileDerivedPages(f.db, f.vault))).toBe(false);
  // Its repair is a change like any other.
  unlinkSync(join(f.vault, "facts/broken.md"));
  settle(f.db, f.vault);
  expect(f.db.query("SELECT status FROM derived_meta WHERE layer='graph'").get()).toEqual({ status: "ok" });
});
