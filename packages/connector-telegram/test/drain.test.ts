import { expect, test } from "bun:test";
import { openLedger, runBackfill, runToCompletion } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { fixtureAccount } from "../src/fixture";
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

test("a run the provider cuts short reports what it stored and where it is", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  const first = await runBackfill(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
  );
  expect(first.stored).toBe(12);

  built.api.disconnectNetwork();
  const cut = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(cut.errors).toEqual(["kizuki.telegram: telegram is unreachable"]);
  // The durable checkpoint is untouched, so the next run resumes rather than
  // starting the account again.
  expect(cut.cursor).toBe(first.cursor);
});

test("a record with an impossible date does not stall the backfill", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    {
      peer_id: "1002",
      peer_type: "user",
      title: "grace",
      public: false,
      top_message_id: 3,
    },
  ];
  account.messages = {
    "1002": [
      { peer_id: "1002", id: 1, date: 1767225600, text: "one", out: false, service: false },
      // Far past the years an RFC3339 timestamp is made of. A batch that
      // carried it would fail, and a failed batch keeps its old checkpoint, so
      // the same page would be re-read and fail again on every later run.
      { peer_id: "1002", id: 2, date: 300_000_000_000, text: "two", out: false, service: false },
      { peer_id: "1002", id: 3, date: 1767225800, text: "three", out: false, service: false },
    ],
  };
  const built = await connected({ account, now: FEBRUARY });
  const db = ledger();
  const result = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(result.errors).toEqual([]);
  expect(result.stored).toBe(2);
  expect(result.cursor).not.toBeNull();
  db.close();
});
