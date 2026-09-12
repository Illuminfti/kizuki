import { expect, test } from "bun:test";
import { setSourceGrant, getCheckpoint, registerConnection, runBackfill, runSync, runToCompletion } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { BATCH_LIMIT, parseCursor } from "../src/cursor";
import { fixtureAccount } from "../src/fixture";
import type { TelegramMessage } from "../src/api";
import { TELEGRAM_CONNECTOR_ID } from "../src/map";
import { connected } from "./helpers";

const FEBRUARY = Date.parse("2026-02-01T00:00:00.000Z");
const SOURCE = "01JJ0000000000000000000000";

function ledger() {
  const db = openLedger(":memory:");
  registerConnection(db, TELEGRAM_CONNECTOR_ID, SOURCE);
  // Explicit synthetic owner consent; keep connector sensitivity authoritative.
  setSourceGrant(db, {
    source_key: SOURCE, expected_revision: 0, operation_id: "fixture-grant",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  return db;
}

function counts(calls: { method: string }[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

function historyMinIds(calls: { method: string; args?: unknown[] }[]): number[] {
  return calls
    .filter((call) => call.method === "messages")
    .map((call) => call.args?.[1] as { min_id: number; max_id?: number })
    .filter((query) => query.max_id === undefined)
    .map((query) => query.min_id);
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
  // Failed first sync keeps the bootstrap token so retry resumes that snapshot.
  // It does not commit a new sync position from the failed walk.
  expect(cut.cursor).toBe(first.cursor);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).toBe(
    first.cursor,
  );
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).toBe(
    first.cursor,
  );

  built.api.reconnectNetwork();
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const retry = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(retry.errors).toEqual([]);
  expect(retry.stored).toBe(0);
  expect(counts(built.api.calls, "dialogs")).toBe(1);
  expect(counts(built.api.calls, "messages")).toBe(6);
  db.close();
});

test("a record with an impossible date does not stall the backfill", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    {
      peer_id: "1002",
      peer_type: "user",
      title: "grace",
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
}, 15_000);

test("restart and a later provider error keep the committed sync cursor", async () => {
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

  built.clock.now += 3_600_000;
  const synced = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  const committed = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor;
  if (typeof committed !== "string") throw new Error("expected a committed sync cursor");
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).not.toBeNull();

  const restarted = await built.restart();
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const afterRestart = await runToCompletion(
    db,
    restarted,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(afterRestart.errors).toEqual([]);
  expect(afterRestart.stored).toBe(0);
  expect(afterRestart.cursor).toBe(committed);
  expect(counts(built.api.calls, "dialogs")).toBe(1);
  expect(counts(built.api.calls, "messages")).toBe(6);

  built.api.disconnectNetwork();
  const failed = await runToCompletion(
    db,
    restarted,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(failed.errors).toEqual(["kizuki.telegram: telegram is unreachable"]);
  expect(failed.cursor).toBe(committed);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).toBe(
    committed,
  );

  built.api.reconnectNetwork();
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const resumed = await runToCompletion(
    db,
    restarted,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(resumed.errors).toEqual([]);
  expect(resumed.stored).toBe(0);
  expect(resumed.cursor).toBe(committed);
  expect(counts(built.api.calls, "dialogs")).toBe(1);
  expect(counts(built.api.calls, "messages")).toBe(6);
  db.close();
});

test("the manifest opts into first-sync bootstrap from the committed backfill token", async () => {
  const built = await connected({ now: FEBRUARY });
  expect(
    built.connector.manifest().capabilities.sync_from_backfill_before_first_success,
  ).toBe(true);
});

test("restart before the first successful sync resumes the committed backfill token", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  const backfilled = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(backfilled.errors).toEqual([]);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).toBeNull();
  const backfillCursor = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor;
  if (typeof backfillCursor !== "string") throw new Error("expected a committed backfill cursor");
  expect(parseCursor(backfillCursor).phase).toBe("synced");

  const restarted = await built.restart();
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const synced = await runToCompletion(
    db,
    restarted,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  expect(synced.duplicates).toBe(0);
  expect(counts(built.api.calls, "dialogs")).toBe(1);
  expect(counts(built.api.calls, "messages")).toBe(6);
  expect(historyMinIds(built.api.calls).every((id) => id > 0)).toBe(true);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).toBe(
    backfillCursor,
  );
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).not.toBeNull();
  db.close();
});

test("a first-sync walk that fails to persist retries the committed backfill token", async () => {
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
  const backfillCursor = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor;
  if (typeof backfillCursor !== "string") throw new Error("expected a committed backfill cursor");

  built.api.append("1002", {
    peer_id: "1002",
    id: 6,
    date: Math.floor(FEBRUARY / 1000) + 3_600,
    text: "one more thing",
    out: false,
    service: false,
  });
  db.exec(`
    CREATE TRIGGER fail_events_insert BEFORE INSERT ON events
    BEGIN
      SELECT RAISE(ABORT, 'SQLITE_IOERR disk I/O error');
    END;
  `);

  built.clock.now += 3_600_000;
  const failed = await runSync(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
  );
  expect(failed.stored).toBe(0);
  expect(failed.errors.some((error) => error.includes("SQLITE_IOERR"))).toBe(true);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).toBe(
    backfillCursor,
  );
  // Failed persist keeps the bootstrap token, not the unpersisted walk.
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).toBe(
    backfillCursor,
  );

  db.exec("DROP TRIGGER fail_events_insert");
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const retry = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(retry.errors).toEqual([]);
  expect(retry.stored).toBe(1);
  expect(retry.duplicates).toBe(0);
  expect(historyMinIds(built.api.calls).every((id) => id > 0)).toBe(true);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).toBe(
    backfillCursor,
  );
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).not.toBe(
    backfillCursor,
  );
  db.close();
});

test("first sync after a partial backfill continues from last_id across restart", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    {
      peer_id: "1",
      peer_type: "user",
      title: "grace",
      top_message_id: 1000,
    },
  ];
  account.messages = { "1": notes("1", 1, 1000) };
  const built = await connected({ account, now: FEBRUARY });
  const db = ledger();
  const first = await runBackfill(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
  );
  expect(first.stored).toBe(BATCH_LIMIT);
  expect(parseCursor(first.cursor as string).phase).toBe("backfill");
  expect(parseCursor(first.cursor as string).dialogs["1"]?.last_id).toBe(
    BATCH_LIMIT,
  );
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).toBeNull();

  const restarted = await built.restart();
  built.clock.now += 3_600_000;
  built.api.calls.length = 0;
  const synced = await runToCompletion(
    db,
    restarted,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "sync",
  );
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(1000 - BATCH_LIMIT);
  expect(synced.duplicates).toBe(0);
  expect(historyMinIds(built.api.calls)).not.toContain(0);
  expect(historyMinIds(built.api.calls)[0]).toBe(BATCH_LIMIT);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor).toBe(
    first.cursor,
  );
  const syncCursor = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor;
  if (typeof syncCursor !== "string") throw new Error("expected a committed sync cursor");
  expect(parseCursor(syncCursor).dialogs["1"]?.last_id).toBe(1000);
  db.close();
}, 15_000);

test("a wait that reached only skipped records keeps its place", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    {
      peer_id: "1",
      peer_type: "user",
      title: "grace",
      top_message_id: 2,
    },
  ];
  account.messages = {
    "1": [
      // Read, and emitted nothing from: the batch is empty for a reason that
      // has nothing to do with the account being drained.
      { peer_id: "1", id: 1, date: 1767225600, text: "", out: false, service: true },
      { peer_id: "1", id: 2, date: 1767225700, text: "second", out: false, service: false },
    ],
  };
  const built = await connected({ account, now: FEBRUARY });
  const db = ledger();
  built.api.floodAfter(0, 600);

  const throttled = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(throttled.stored).toBe(0);
  expect(throttled.errors).toEqual([]);
  // The record it skipped is behind the checkpoint, so the wait costs the run
  // nothing but the time it asks for.
  expect(
    parseCursor(throttled.cursor as string).dialogs["1"]?.last_id,
  ).toBe(1);
  expect((await built.connector.health()).state).toBe("rate_limited");

  built.clock.now += 600_000;
  built.api.calls.length = 0;
  const resumed = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(resumed.errors).toEqual([]);
  expect(resumed.stored).toBe(1);
  expect(
    built.api.calls
      .filter((call) => call.method === "messages")
      .map((call) => (call.args[1] as { min_id: number }).min_id),
  ).toEqual([1]);
  db.close();
});

function chatter(peer_id: string, from: number, to: number, service: boolean): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  for (let id = from; id <= to; id += 1) {
    messages.push({
      peer_id,
      id,
      date: Math.floor(Date.UTC(2026, 1, 1, 0, 0, 0) / 1000) + id,
      text: service ? "" : `note ${id}`,
      out: false,
      service,
    });
  }
  return messages;
}

/**
 * A dialog whose leading history emits nothing — service messages, or dates
 * the ledger refuses — reaches a wait before the batch has collected its first
 * event. The pages it consumed are real work, and the ids it advanced past are
 * what makes the next run start further on. Throwing them away turns an
 * ordinary throttle into a run that reads the same pages for ever and never
 * reaches the messages behind them.
 */
test("a throttled run keeps the ground the walk already covered", async () => {
  const account = fixtureAccount();
  account.dialogs = [
    { peer_id: "1", peer_type: "user", title: "grace", top_message_id: 2005 },
  ];
  account.messages = {
    "1": [...chatter("1", 1, 2000, true), ...chatter("1", 2001, 2005, false)],
  };
  const built = await connected({ account, now: FEBRUARY });
  const db = ledger();

  const marks: number[] = [];
  let stored = 0;
  for (let attempt = 0; attempt < 8 && stored < 5; attempt += 1) {
    // The provider throttles this account on every run, two pages in.
    built.api.floodAfter(2, 600);
    const result = await runToCompletion(
      db,
      built.connector,
      TELEGRAM_CONNECTOR_ID,
      SOURCE,
      "backfill",
    );
    stored += result.stored;
    // A run inside a wait reports the wait and nothing else.
    for (const error of result.errors) {
      expect(error).toBe("kizuki.telegram: telegram asked us to wait 600s");
    }
    if (attempt === 0) {
      // The wait is not lost with the batch: it is what health reports.
      expect((await built.connector.health()).state).toBe("rate_limited");
    }
    const checkpoint = result.cursor;
    expect(checkpoint).not.toBeNull();
    marks.push(parseCursor(checkpoint as string).dialogs["1"]?.last_id ?? 0);
    built.clock.now += 600_000;
  }

  // Every run moved the durable checkpoint on, so the five messages behind
  // two thousand skipped ones are reached in a handful of runs rather than
  // never.
  expect(marks).toEqual([...marks].sort((left, right) => left - right));
  expect(new Set(marks).size).toBe(marks.length);
  expect(marks.length).toBeLessThanOrEqual(4);
  expect(stored).toBe(5);
  db.close();
});
