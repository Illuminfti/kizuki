import { expect, test } from "bun:test";
import { BATCH_LIMIT, parseCursor } from "../src/cursor";
import {
  fixtureAccount,
} from "../src/fixture";
import type { TelegramMessage } from "../src/api";
import { connected, drain } from "./helpers";

const NON_SERVICE = 12;

function busyAccount(count: number) {
  const account = fixtureAccount();
  const messages: TelegramMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({
      peer_id: "1002",
      id: index,
      date: Math.floor(Date.UTC(2026, 0, 2, 0, 0, 0) / 1000) + index,
      text: `note ${index}`,
      out: index % 2 === 0,
      service: false,
    });
  }
  account.dialogs = [
    {
      peer_id: "1002",
      peer_type: "user",
      title: "grace",
      public: false,
      top_message_id: count,
    },
  ];
  account.messages = { "1002": messages };
  return account;
}

test("the first batch seeds every dialog it listed", async () => {
  const built = await connected();
  const batch = await built.connector.backfill(null);
  const cursor = parseCursor(batch.cursor as string);
  expect(Object.keys(cursor.dialogs).sort()).toEqual([
    "-100777",
    "-42",
    "1002",
  ]);
  expect(cursor.dialogs["1002"]).toEqual({
    peer_type: "user",
    last_id: 5,
    exhausted: true,
  });
  expect(batch.events).toHaveLength(NON_SERVICE);
});

test("no batch exceeds the batch limit and the walk then reports drained", async () => {
  const built = await connected({ account: busyAccount(1200) });
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 4; round += 1) {
    const batch = await built.connector.backfill(cursor);
    sizes.push(batch.events.length);
    cursor = batch.cursor;
  }
  expect(sizes).toEqual([BATCH_LIMIT, BATCH_LIMIT, 200, 0]);
  expect(parseCursor(cursor as string).phase).toBe("synced");
});

test("a cursor from a completed walk makes backfill a no-op", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  expect(parseCursor(drained.cursor).phase).toBe("synced");
  built.api.calls.length = 0;
  const again = await built.connector.backfill(drained.cursor);
  expect(again.events).toEqual([]);
  expect(again.cursor).toBe(drained.cursor);
  // A settled backfill costs nothing: no listing, so no further chance to be
  // told to wait by an account that has nothing left to give.
  expect(built.api.calls).toEqual([]);
});

test("a settled backfill stays quiet even when telegram is unreachable", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  built.api.disconnectNetwork();
  expect((await built.connector.backfill(drained.cursor)).events).toEqual([]);
});

test("resuming after a reported wait replays nothing and misses nothing", async () => {
  const built = await connected();
  built.api.floodAfter(0, 5);

  const first = await built.connector.backfill(null);
  expect(first.events).toHaveLength(1);
  expect(first.events[0]?.source_record_id).toBe("-100777:20");
  const stopped = parseCursor(first.cursor as string);
  expect(stopped.dialogs["-100777"]?.last_id).toBe(20);
  expect(stopped.dialogs["-42"]?.last_id).toBe(0);

  const rest = await drain(built.connector, "backfill", first.cursor);
  const ids = [...first.events, ...rest.events].map(
    (event) => event.source_record_id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(NON_SERVICE);
});

test("two walks from an empty cursor produce identical events", async () => {
  const built = await connected();
  const first = await built.connector.backfill(null);
  const second = await built.connector.backfill(null);
  expect(second.events).toEqual(first.events);
  expect(second.cursor).toBe(first.cursor);
});

test("the walk never surrenders its cursor", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  expect(drained.cursor).not.toBeNull();
  expect(drained.events).toHaveLength(NON_SERVICE);
});

function crowd(peer_id: string, count: number): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({
      peer_id,
      id: index,
      date: Math.floor(Date.UTC(2026, 0, 2, 0, 0, 0) / 1000) + index,
      text: `${peer_id} note ${index}`,
      out: false,
      service: false,
    });
  }
  return messages;
}

function pair(count: number) {
  const account = fixtureAccount();
  account.dialogs = ["1002", "1003"].map((peer_id) => ({
    peer_id,
    peer_type: "user" as const,
    title: "grace",
    public: false,
    top_message_id: count,
  }));
  account.messages = { "1002": crowd("1002", count), "1003": crowd("1003", count) };
  return account;
}

test("a dialog the account stopped listing does not finish the backfill", async () => {
  const built = await connected({ account: pair(400) });
  const first = await built.connector.backfill(null);
  expect(first.events).toHaveLength(BATCH_LIMIT);
  expect(parseCursor(first.cursor as string).dialogs["1003"]?.last_id).toBe(100);

  // A listing only changes what a walk sees when the walk starts again, so
  // this is the next run rather than the next batch.
  built.api.hideDialog("1003");
  const resumed = await built.restart();
  const second = await resumed.backfill(first.cursor);
  const stalled = parseCursor(second.cursor as string);
  expect(second.events).toEqual([]);
  expect(stalled.dialogs["1003"]).toEqual({
    peer_type: "user",
    last_id: 100,
    exhausted: false,
  });
  expect(stalled.phase).toBe("backfill");

  const report = await resumed.health();
  expect(report.state).toBe("degraded");
  expect(report.detail).toContain("1003");

  built.api.showDialogs();
  const recovered = await built.restart();
  const rest = await drain(recovered, "backfill", second.cursor);
  expect(rest.events).toHaveLength(300);
  expect(parseCursor(rest.cursor).phase).toBe("synced");
  expect((await recovered.health()).state).toBe("ok");
});

test("a page of service messages moves the cursor without emitting anything", async () => {
  const account = fixtureAccount();
  const messages: TelegramMessage[] = [];
  for (let id = 1; id <= BATCH_LIMIT; id += 1) {
    messages.push({
      peer_id: "-42",
      id,
      date: Math.floor(Date.UTC(2026, 0, 3, 0, 0, 0) / 1000) + id,
      text: "",
      out: false,
      service: true,
    });
  }
  for (let id = BATCH_LIMIT + 1; id <= BATCH_LIMIT + 3; id += 1) {
    messages.push({
      peer_id: "-42",
      id,
      date: Math.floor(Date.UTC(2026, 0, 3, 0, 0, 0) / 1000) + id,
      text: `note ${id}`,
      out: false,
      service: false,
    });
  }
  account.dialogs = [
    {
      peer_id: "-42",
      peer_type: "group",
      title: "acme planning",
      public: false,
      top_message_id: BATCH_LIMIT + 3,
    },
  ];
  account.messages = { "-42": messages };

  const built = await connected({ account });
  const first = await built.connector.backfill(null);
  expect(first.events).toEqual([]);
  // Empty is not the same as finished: the runner has to look at the cursor.
  expect(parseCursor(first.cursor as string).dialogs["-42"]).toEqual({
    peer_type: "group",
    last_id: BATCH_LIMIT,
    exhausted: false,
  });

  const rest = await drain(built.connector, "backfill", first.cursor);
  expect(rest.events).toHaveLength(3);
  expect(parseCursor(rest.cursor).phase).toBe("synced");
});

test("continuing a walk costs one dialog listing, not one per batch", async () => {
  const built = await connected({ account: busyAccount(1200) });
  const drained = await drain(built.connector, "backfill");
  expect(drained.batches).toBe(4);
  const listings = built.api.calls.filter((call) => call.method === "dialogs");
  // The dialog set a backfill walks is fixed when it is seeded, so re-listing
  // per batch buys nothing and spends a request against the same rate limit.
  expect(listings).toHaveLength(1);

  // The next run has nothing carried over and lists once more.
  const resumed = await built.restart();
  built.api.calls.length = 0;
  await drain(resumed, "sync", drained.cursor);
  expect(built.api.calls.filter((call) => call.method === "dialogs")).toHaveLength(
    1,
  );
});
