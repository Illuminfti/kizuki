import { afterEach, expect, test } from "bun:test";
import { OWNER, accept, reserveAudit } from "@kizuki/core";
import { STORED_ROWS_SQL, reconcileFixture, underForeignWriteLock, watchingQueries } from "../../core/test/derived/reconcile-fixture";
import { validEvent } from "../../core/test/fixtures";
import { refreshDerived } from "../src/derived";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

/** A refresh, and how many times it compared every page with its stored row. */
function comparing<T>(db: Parameters<typeof watchingQueries>[0], during: () => void, refresh: () => T): { report: T; compared: number } {
  let compared = 0;
  const report = watchingQueries(db, sql => { if (sql.includes(STORED_ROWS_SQL)) { compared += 1; during(); } }, refresh);
  return { report, compared };
}

test("an idle refresh on a long-lived handle compares no page and takes no write lock", async () => {
  const f = await reconcileFixture(cleanup);
  expect(refreshDerived(f.db, f.vault)).toMatchObject({ remaining: 0, degraded: [] });
  // The fixture's files leave the racy window; then a pass leaves its inputs verified.
  await Bun.sleep(2_100);
  refreshDerived(f.db, f.vault);
  refreshDerived(f.db, f.vault);
  const idle = underForeignWriteLock(f.db, f.other(), () => comparing(f.db, () => {}, () => refreshDerived(f.db, f.vault)));
  expect(idle.compared).toBe(0);
  expect(idle.report).toMatchObject({ events: 0, pages: 0, remaining: 0, degraded: [] });
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});

test("a refresh after a capture compares once while a served call is audited, and the next refresh is idle", async () => {
  const f = await reconcileFixture(cleanup);
  refreshDerived(f.db, f.vault);
  await Bun.sleep(2_100);
  refreshDerived(f.db, f.vault);
  refreshDerived(f.db, f.vault);
  // An ordinary capture by another process: one event and no page change.
  expect(accept(f.other(5_000), { ...validEvent(), connector_id: "fixture", source_record_id: "capture-between-sweeps" }).status).toBe("stored");
  const reader = f.other();
  const audited: string[] = [];
  const sweep = comparing(f.db, () => audited.push(reserveAudit(reader, OWNER, "search", { query: "tea" }).audit_id), () => refreshDerived(f.db, f.vault));
  expect(sweep.report).toMatchObject({ events: 1, pages: 0, remaining: 0, degraded: [] });
  // The reader is not refused, and its audit row does not send the sweep back to compare again.
  expect(audited).toHaveLength(1);
  expect(sweep.compared).toBe(1);
  const idle = underForeignWriteLock(f.db, f.other(), () => comparing(f.db, () => {}, () => refreshDerived(f.db, f.vault)));
  expect(idle.compared).toBe(0);
  expect(idle.report).toMatchObject({ events: 0, pages: 0, remaining: 0, degraded: [] });
});
