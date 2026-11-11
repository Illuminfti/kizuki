import { afterEach, expect, test } from "bun:test";
import { reconcileFixture, underForeignWriteLock } from "../../core/test/derived/reconcile-fixture";
import { refreshDerived } from "../src/derived";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

test("an idle refresh on a long-lived handle takes no write lock", async () => {
  const f = await reconcileFixture(cleanup);
  expect(refreshDerived(f.db, f.vault)).toMatchObject({ remaining: 0, degraded: [] });
  // The fixture's files leave the racy window; then one pass confirms the last one's writes.
  await Bun.sleep(2_100);
  refreshDerived(f.db, f.vault);
  refreshDerived(f.db, f.vault);
  const idle = underForeignWriteLock(f.db, f.other(), () => refreshDerived(f.db, f.vault));
  expect(idle).toMatchObject({ events: 0, pages: 0, remaining: 0, degraded: [] });
  expect(f.indexed()).toEqual(["facts/kettle.md", "facts/tea.md"]);
});
