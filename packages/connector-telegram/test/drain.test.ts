import { expect, test } from "bun:test";
import { openLedger, runBackfill, runToCompletion } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { parseCursor } from "../src/cursor";
import { fixtureAccount } from "../src/fixture";
import type { TelegramMessage } from "../src/api";
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

test("a listing the provider throttled is reported, not counted as drained", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  built.api.floodListing(600);

  // An empty batch is this connector's word for a drained account. Handing one
  // back here would tell the runner the account holds nothing, when the truth
  // is that nothing was read at all.
  const throttled = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(throttled.stored).toBe(0);
  expect(throttled.errors).toEqual([
    "kizuki.telegram: telegram asked us to wait 600s",
  ]);
  expect(throttled.cursor).toBeNull();
  expect((await built.connector.health()).state).toBe("rate_limited");

  // And a retry inside the wait is the same answer, without a request.
  built.api.calls.length = 0;
  const early = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(early.errors).toEqual([
    "kizuki.telegram: telegram asked us to wait 600s",
  ]);
  expect(built.api.calls).toEqual([]);

  built.clock.now += 600_000;
  const resumed = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(resumed.errors).toEqual([]);
  expect(resumed.stored).toBe(12);
  db.close();
});

function notes(peer_id: string, from: number, to: number): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  for (let id = from; id <= to; id += 1) {
    messages.push({
      peer_id,
      id,
      date: Math.floor(Date.UTC(2026, 1, 1, 0, 0, 0) / 1000) + id,
      text: `note ${id}`,
      out: false,
      service: false,
    });
  }
  return messages;
}

test("a wait during a resumed edit scan reads as a wait, not a stuck connector", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    {
      peer_id: "1",
      peer_type: "user",
      title: "grace",
      public: false,
      top_message_id: 1000,
    },
  ];
  account.messages = { "1": notes("1", 1, 1000) };
  const built = await connected({ account, now: FEBRUARY });
  const db = ledger();
  const backfilled = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(backfilled.stored).toBe(1000);
  const watermark = parseCursor(backfilled.cursor as string).edit_watermark;
  // A pass that cannot finish in one batch: two hundred edits behind the
  // window, and four hundred new messages in front of them.
  for (const message of notes("1", 1001, 1400)) built.api.append("1", message);
  for (let id = 801; id <= 1000; id += 1) {
    built.api.edit("1", id, `rewritten ${id}`, watermark + 60);
  }
  // The edit the resumed pass finds first, so the wait lands after an event
  // was already collected and the cursor still has nowhere to move.
  built.api.edit("1", 1101, "rewritten 1101", watermark + 60);
  built.api.floodAfter(2, 900);

  const cut = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(cut.stored).toBe(500);
  expect(cut.errors).toEqual([
    "kizuki.telegram: telegram asked us to wait 900s",
  ]);
  expect((await built.connector.health()).state).toBe("rate_limited");
  db.close();
});
