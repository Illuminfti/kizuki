import { afterEach, expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { reserveAudit } from "../../src/agents/audit";
import { reconcileDerivedPages } from "../../src/derived-refresh";
import { isLedgerBusy } from "../../src/ledger/busy";
import { openLedger } from "../../src/ledger/db";
import { removeCanonPath } from "../../src/search/indexer";
import { serveSearch } from "../../src/serving/search";
import { STORED_ROWS_SQL, foreignWriter, reconcileFixture, underForeignWriteLock, watchingQueries } from "./reconcile-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const audits = (db: import("bun:sqlite").Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_audit").get()!.n;

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

test("a reader's audit row is written while a pass compares pages", async () => {
  const f = await reconcileFixture(cleanup);
  // Something to write, so the pass goes on to take the lock after comparing.
  removeCanonPath(f.db, "facts/tea.md");
  const reader = f.other();
  let audited: string | undefined;
  const wrote = watchingQueries(f.db, sql => {
    if (audited === undefined && sql.includes(STORED_ROWS_SQL)) audited = reserveAudit(reader, OWNER, "search", { query: "tea" }).audit_id;
  }, () => reconcileDerivedPages(f.db, f.vault));
  expect(audited).toBeString();
  expect(wrote).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a commit that lands while a pass plans is planned again, never written from the stale plan", async () => {
  const f = await reconcileFixture(cleanup);
  reconcileDerivedPages(f.db, f.vault);
  // A hold whose page is still indexed: the plan read on this state withdraws it.
  f.db.query("INSERT INTO canon_holds VALUES (?, ?, ?, ?)").run("facts/tea.md", "synthetic-hold", "synthetic recovery", "2026-09-29T12:00:00.000Z");
  const writer = f.other();
  let plans = 0;
  watchingQueries(f.db, sql => {
    if (!sql.includes(STORED_ROWS_SQL)) return;
    // The hold is lifted after the first plan read it and before that plan could be written.
    if ((plans += 1) === 1) writer.query("DELETE FROM canon_holds").run();
  }, () => reconcileDerivedPages(f.db, f.vault));
  expect(plans).toBe(2);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a pass raced on every plan plans once under the lock and writes what that plan read", async () => {
  const f = await reconcileFixture(cleanup);
  removeCanonPath(f.db, "facts/tea.md");
  const reader = f.other();
  const racers: string[] = [];
  const wrote = watchingQueries(f.db, sql => {
    if (!sql.includes(STORED_ROWS_SQL)) return;
    try {
      reserveAudit(reader, OWNER, "search", { query: "tea" });
      racers.push("committed");
    } catch (error) {
      if (!isLedgerBusy(error)) throw error;
      racers.push("refused");
    }
  }, () => reconcileDerivedPages(f.db, f.vault));
  // Two plans off the lock were each raced; the third held the lock, so nothing could race it.
  expect(racers).toEqual(["committed", "committed", "refused"]);
  expect(wrote).toBe(true);
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
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
