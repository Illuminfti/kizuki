import { expect, test } from "bun:test";
import { openLedger, runToCompletion } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { TELEGRAM_CONNECTOR_ID } from "../src/map";
import { connected } from "./helpers";

const FEBRUARY = Date.parse("2026-02-01T00:00:00.000Z");
const SOURCE = "01JJ0000000000000000000000";

function ledger() {
  const db = openLedger(":memory:");
  initStaging(db);
  return db;
}

function counts(calls: { method: string }[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

test("the runner drains a backfill and stores every non-service message", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  const result = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(result.errors).toEqual([]);
  expect(result.stored).toBe(12);
  db.close();
});

test("a scheduled sync of a settled account costs one pass, not the bound", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  expect(
    (
      await runToCompletion(
        db,
        built.connector,
        TELEGRAM_CONNECTOR_ID,
        SOURCE,
        "backfill",
      )
    ).errors,
  ).toEqual([]);

  // An hour later, with nothing to report: the shape of every scheduled sync
  // after the first. The clock has to move, because a frozen one hides a
  // cursor that carries the time of the last pass.
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const synced = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  expect(counts(built.api.calls, "dialogs")).toBe(1);
  // One new-message read and one edit-window read per dialog, once.
  expect(counts(built.api.calls, "messages")).toBe(6);
});
