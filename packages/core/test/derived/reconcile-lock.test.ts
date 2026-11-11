import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { reserveAudit } from "../../src/agents/audit";
import { reconcileDerivedPages, reconcileDerivedPagesWhenChanged } from "../../src/derived-refresh";
import { isLedgerBusy } from "../../src/ledger/busy";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { removeCanonPath } from "../../src/search/indexer";
import { serveSearch } from "../../src/serving/search";
import { validEvent } from "../fixtures";
import { STORED_ROWS_SQL, foreignPage, foreignWriter, reconcileFixture, underForeignWriteLock, watchingQueries } from "./reconcile-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const audits = (db: Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_audit").get()!.n;
const body = (db: Database, path: string) => db.query<{ body: string }, [string]>("SELECT body FROM search_documents WHERE scope='canon' AND path=?").get(path)?.body;
const linksTo = (db: Database, dst: string) => db.query<{ src: string }, [string]>("SELECT src FROM graph_edges WHERE kind='wikilink' AND dst=? ORDER BY src").all(dst).map(row => row.src);

/** Runs `pass`, calling `during` with the number of each comparison as the pass issues it. */
function atEachPlan<T>(db: Database, during: (plan: number) => void, pass: () => T): { result: T; plans: number } {
  let plans = 0;
  const result = watchingQueries(db, sql => { if (sql.includes(STORED_ROWS_SQL)) during(plans += 1); }, pass);
  return { result, plans };
}

/** A capture by another process: a new event, which every plan reads. */
function capture(db: Database, record: string): void {
  if (accept(db, { ...validEvent(), connector_id: "fixture", source_record_id: record }).status !== "stored") throw new Error("capture was not stored");
}

/** `capture` that reports whether the write lock let it through. */
function tryCapture(db: Database, record: string): "committed" | "refused" {
  try { capture(db, record); return "committed"; } catch (error) { if (!isLedgerBusy(error)) throw error; return "refused"; }
}

test("a pass with nothing to write compares every page without taking the write lock", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  let compared = 0;
  const wrote = underForeignWriteLock(f.db, f.other(), () =>
    watchingQueries(f.db, sql => { if (sql.includes(STORED_ROWS_SQL)) compared += 1; }, () => reconcileDerivedPages(f.db, f.vault)));
  expect(compared).toBe(1);
  expect(wrote).toBe(false);
});

test("a reader's audit row is written while a pass compares pages, and the plan it read is still written", async () => {
  const f = await reconcileFixture(cleanup);
  // Something to write, so the pass goes on to take the lock after comparing.
  removeCanonPath(f.db, "facts/tea.md");
  const reader = f.other();
  const audited: string[] = [];
  const pass = atEachPlan(f.db, () => audited.push(reserveAudit(reader, OWNER, "search", { query: "tea" }).audit_id), () => reconcileDerivedPages(f.db, f.vault));
  // An audit row is no input of a pass: one comparison, not one per served call.
  expect(audited).toHaveLength(1);
  expect(pass).toEqual({ result: true, plans: 1 });
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a commit that lands while a pass plans is planned again, never written from the stale plan", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  // A hold whose page is still indexed: the plan read on this state withdraws it.
  f.db.query("INSERT INTO canon_holds VALUES (?, ?, ?, ?)").run("facts/tea.md", "synthetic-hold", "synthetic recovery", "2026-09-29T12:00:00.000Z");
  const writer = f.other();
  // The hold is lifted after the first plan read it and before that plan could be written.
  const pass = atEachPlan(f.db, plan => { if (plan === 1) writer.query("DELETE FROM canon_holds").run(); }, () => reconcileDerivedPages(f.db, f.vault));
  expect(pass.plans).toBe(2);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a receipted edit by another process during a plan stays in the index", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  removeCanonPath(f.db, "facts/kettle.md");
  // The first plan walked tea before this edit; written, it would put the old body back over the writer's row.
  const pass = atEachPlan(f.db, plan => { if (plan === 1) foreignPage(f.vault, "tea", "tea with [[Cup]] and milk."); }, () => reconcileDerivedPages(f.db, f.vault));
  expect(pass.plans).toBe(2);
  expect(readFileSync(join(f.vault, "facts/tea.md"), "utf8")).toContain("and milk");
  expect(body(f.db, "facts/tea.md")).toContain("and milk");
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  const served = await serveSearch({ db: f.db, vaultPath: f.vault, principal: OWNER }, { query: "milk" });
  expect(served.canon.map(chunk => chunk.path)).toEqual(["facts/tea.md"]);
});

test("a page filed by another process during a plan is not withdrawn", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  removeCanonPath(f.db, "facts/kettle.md");
  // The first plan's walk never saw cup, and its snapshot predates cup's row: a row with no page is withdrawn.
  const pass = atEachPlan(f.db, plan => { if (plan === 1) foreignPage(f.vault, "cup", "A cup for [[tea]]."); }, () => reconcileDerivedPages(f.db, f.vault));
  expect(pass.plans).toBe(2);
  expect(f.indexed()).toEqual(["facts/cup.md", "facts/kettle.md", "facts/tea.md"]);
  expect(linksTo(f.db, "fact:cup")).toEqual(["fact:kettle", "fact:tea"]);
  expect(linksTo(f.db, "fact:tea")).toEqual(["fact:cup"]);
});

test("a page changed on disk after the walk is read again before anything is written", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  removeCanonPath(f.db, "facts/kettle.md");
  const tea = join(f.vault, "facts/tea.md");
  // No ledger row moves: only the file's signature says the walk is stale.
  const pass = atEachPlan(f.db, plan => { if (plan === 1) writeFileSync(tea, readFileSync(tea, "utf8").replace("tea with", "TEA with")); }, () => reconcileDerivedPages(f.db, f.vault));
  expect(pass.plans).toBe(2);
  // The unreceipted revision leaves the index in this pass, not the next.
  expect(f.indexed()).toEqual(["facts/kettle.md"]);
});

test("a walk cut short by the scan budget is still written from one comparison", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  // The smallest budget the vault accepts, a page that does not fit in it, and one the walk never reaches.
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), "[canon]\nmax_scan_bytes = 65536\n");
  writeFileSync(join(f.vault, "facts/large.md"), `---\nid: fact:large\n---\n${"filler ".repeat(10_000)}`);
  writeFileSync(join(f.vault, "facts/later.md"), "---\nid: fact:later\n---\nNever read.");
  const pass = atEachPlan(f.db, () => {}, () => reconcileDerivedPages(f.db, f.vault));
  // Its stamps are written off the lock like any other plan's, not by planning under it.
  expect(pass).toEqual({ result: true, plans: 1 });
  expect(f.db.query("SELECT status FROM derived_meta WHERE layer='search'").get()).toEqual({ status: "degraded" });
});

test("a pass raced on every plan plans once under the lock and writes what that plan read", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  f.db.query("INSERT INTO canon_holds VALUES (?, ?, ?, ?)").run("facts/tea.md", "synthetic-hold", "synthetic recovery", "2026-09-29T12:00:00.000Z");
  const writer = f.other();
  const racers: string[] = [];
  const pass = atEachPlan(f.db, plan => {
    try {
      // Each plan off the lock is stale by the time it could be written: the first would withdraw tea, the second kettle.
      if (plan === 1) writer.query("UPDATE canon_holds SET page_path='facts/kettle.md'").run();
      else writer.query("DELETE FROM canon_holds").run();
      racers.push("committed");
    } catch (error) {
      if (!isLedgerBusy(error)) throw error;
      racers.push("refused");
    }
  }, () => reconcileDerivedPages(f.db, f.vault));
  // The third plan held the lock, so nothing could race it.
  expect(racers).toEqual(["committed", "committed", "refused"]);
  expect(pass.result).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a timed refresh raced on every plan gives way without the lock, and finishes under it only when that keeps happening", async () => {
  const f = await reconcileFixture(cleanup);
  // Past the racy window, so the fixture's files count as settled.
  let now = Date.now() + 5_000;
  const refresh = () => reconcileDerivedPagesWhenChanged(f.db, f.vault, now += 300_000);
  while (refresh()) { /* until the handle has a verified pass behind it */ }
  removeCanonPath(f.db, "facts/kettle.md");
  const other = f.other();
  let record = 0;
  const raced = () => {
    const racers: string[] = [];
    atEachPlan(f.db, () => racers.push(tryCapture(other, `raced-${record += 1}`)), refresh);
    return racers;
  };
  // Two sweeps in a row give way: no third plan, nothing written, the lock never held for a comparison.
  expect(raced()).toEqual(["committed", "committed"]);
  expect(raced()).toEqual(["committed", "committed"]);
  expect(f.indexed()).toEqual(["facts/tea.md"]);
  // The repair may not wait forever: the next raced sweep finishes under the lock.
  expect(raced()).toEqual(["committed", "committed", "refused"]);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
  // Giving way starts over after a pass that finished.
  removeCanonPath(f.db, "facts/kettle.md");
  expect(raced()).toEqual(["committed", "committed"]);
  expect(atEachPlan(f.db, () => {}, refresh)).toEqual({ result: true, plans: 1 });
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a handle's first timed refresh finishes even when every plan is raced", async () => {
  const f = await reconcileFixture(cleanup);
  removeCanonPath(f.db, "facts/kettle.md");
  const other = f.other();
  const racers: string[] = [];
  // A command that refreshes once has no later pass to leave the repair to.
  atEachPlan(f.db, plan => racers.push(tryCapture(other, `first-${plan}`)), () => reconcileDerivedPagesWhenChanged(f.db, f.vault));
  expect(racers).toEqual(["committed", "committed", "refused"]);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a capture is stamped by one comparison while served calls are audited, and the stamps settle the refresh", async () => {
  const f = await reconcileFixture(cleanup);
  let now = Date.now() + 5_000;
  const refresh = () => reconcileDerivedPagesWhenChanged(f.db, f.vault, now += 300_000);
  while (refresh()) { /* settled */ }
  const stamps = () => JSON.stringify(f.db.query("SELECT layer, status, doc_count, source_count, skipped_count, ledger_watermark FROM derived_meta ORDER BY layer").all());
  const rows = () => JSON.stringify([f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all(), f.db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all()]);
  const before = { stamps: stamps(), rows: rows() };
  capture(f.other(5_000), "capture-during-reads");
  const reader = f.other();
  const audited: string[] = [];
  const pass = atEachPlan(f.db, () => audited.push(reserveAudit(reader, OWNER, "search", { query: "tea" }).audit_id), refresh);
  // The new event moves both health stamps, so this pass writes. The reader is never refused and costs no second comparison.
  expect(pass).toEqual({ result: true, plans: 1 });
  expect(audited).toHaveLength(1);
  expect(stamps()).not.toBe(before.stamps);
  expect(rows()).toBe(before.rows);
  // The stamps are what the plan verified, so the next refresh skips, and a pass forced to compare agrees.
  expect(atEachPlan(f.db, () => {}, refresh)).toEqual({ result: false, plans: 0 });
  expect(underForeignWriteLock(f.db, f.other(), () => reconcileDerivedPages(f.db, f.vault))).toBe(false);
});

test("an audit reservation waits out a writer that holds the ledger longer than one busy wait", async () => {
  const f = await reconcileFixture(cleanup);
  const audit = f.other(1_000);
  const writer = await foreignWriter(f.dbPath, 2_500);
  const started = Date.now();
  expect(reserveAudit(audit, OWNER, "search", { query: "tea" }).allow).toBe(true);
  expect(Date.now() - started).toBeGreaterThan(1_000);
  expect(await writer.exited).toBe(0);
});

test("an audit reservation stops waiting within its bound and leaves no row", async () => {
  const f = await reconcileFixture(cleanup);
  const audit = f.other(100);
  const before = audits(f.db);
  const writer = await foreignWriter(f.dbPath, 2_500);
  const started = Date.now();
  let refused: unknown;
  try { reserveAudit(audit, OWNER, "search", { query: "tea" }); } catch (error) { refused = error; }
  expect(isLedgerBusy(refused)).toBe(true);
  // Four busy waits of 100 ms and their backoff, not the writer's two and a half seconds.
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await writer.exited).toBe(0);
  expect(audits(f.db)).toBe(before);
});

test("a served search is audited and answered once a short writer burst ends", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  const serving = openLedger(f.dbPath, { busyTimeoutMs: 1_000 });
  cleanup.push(() => serving.close());
  const before = audits(f.db);
  const writer = await foreignWriter(f.dbPath, 2_500);
  const started = Date.now();
  const envelope = await serveSearch({ db: serving, vaultPath: f.vault, principal: OWNER }, { query: "tea" });
  // The burst outlasted one busy wait, and the answer waited for its audit row.
  expect(Date.now() - started).toBeGreaterThan(1_000);
  expect(envelope.canon.map(chunk => chunk.path)).toEqual(["facts/tea.md"]);
  expect(audits(f.db)).toBe(before + 1);
  expect(await writer.exited).toBe(0);
});
