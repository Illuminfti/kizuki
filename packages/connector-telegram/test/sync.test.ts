import { expect, test } from "bun:test";
import { computeContentHash } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { MAX_DIALOGS, parseCursor } from "../src/cursor";
import { fixtureAccount } from "../src/scripted";
import type { TelegramMessage } from "../src/api";
import { connected, drain } from "./helpers";

const FEBRUARY = Date.parse("2026-02-01T00:00:00.000Z");
const LATER = Math.floor(Date.UTC(2026, 1, 2, 9, 0, 0) / 1000);

async function caughtUp() {
  const built = await connected({ now: FEBRUARY });
  const drained = await drain(built.connector, "backfill");
  const settled = await built.connector.sync(drained.cursor);
  expect(settled.events).toEqual([]);
  return { built, backfilled: drained.events, cursor: settled.cursor as string };
}

function ids(events: CaptureEventInput[]): string[] {
  return events.map((event) => event.source_record_id);
}

test("a sync with nothing new returns an empty batch and keeps its cursor", async () => {
  const { built, cursor } = await caughtUp();
  const again = await built.connector.sync(cursor);
  expect(again.events).toEqual([]);
  expect(parseCursor(again.cursor as string).pass).toBeNull();
});

test("an edit older than the last completed pass is not re-emitted", async () => {
  const { built, cursor } = await caughtUp();
  const watermark = parseCursor(cursor).edit_watermark;
  built.api.edit("-42", 11, "stale rewrite", watermark - 60);
  expect((await built.connector.sync(cursor)).events).toEqual([]);
});

test("an edit inside the window re-emits the same record with a new hash", async () => {
  const { built, backfilled, cursor } = await caughtUp();
  const watermark = parseCursor(cursor).edit_watermark;
  built.api.edit("-42", 11, "on my way now", watermark + 60);

  const batch = await built.connector.sync(cursor);
  expect(ids(batch.events)).toEqual(["-42:11"]);
  const edited = batch.events[0] as CaptureEventInput;
  const original = backfilled.find(
    (event) => event.source_record_id === "-42:11",
  ) as CaptureEventInput;
  expect(edited.text).toBe("on my way now");
  expect(edited.metadata["edit_date"]).toBe(watermark + 60);
  expect(computeContentHash(edited)).not.toBe(computeContentHash(original));
});

test("messages that arrived since the last pass are emitted", async () => {
  const { built, cursor } = await caughtUp();
  built.api.append("1002", {
    peer_id: "1002",
    id: 6,
    date: LATER,
    text: "one more thing",
    out: false,
    service: false,
  });
  const batch = await built.connector.sync(cursor);
  expect(ids(batch.events)).toEqual(["1002:6"]);
  expect(parseCursor(batch.cursor as string).dialogs["1002"]?.last_id).toBe(6);
});

test("a dialog that appeared after the last pass is walked from its start", async () => {
  const { built, cursor } = await caughtUp();
  built.api.addDialog(
    {
      peer_id: "-100999",
      peer_type: "channel",
      title: "acme releases",
      public: true,
      top_message_id: 2,
    },
    [
      {
        peer_id: "-100999",
        id: 1,
        date: LATER,
        text: "first post",
        out: false,
        service: false,
      },
      {
        peer_id: "-100999",
        id: 2,
        date: LATER + 60,
        text: "second post",
        out: false,
        service: false,
      },
    ],
  );
  const batch = await built.connector.sync(cursor);
  expect(ids(batch.events)).toEqual(["-100999:1", "-100999:2"]);
  expect(batch.events[0]?.sensitivity_hint).toBe("public");
});

test("a pass interrupted by a reported wait resumes at the dialog it stopped on", async () => {
  const { built, cursor } = await caughtUp();
  built.api.floodAfter(2, 5);

  const partial = await built.connector.sync(cursor);
  const stopped = parseCursor(partial.cursor as string);
  expect(stopped.pass?.next_peer).toBe("-42");

  built.api.calls.length = 0;
  const finished = await built.connector.sync(partial.cursor);
  expect(parseCursor(finished.cursor as string).pass).toBeNull();
  const visited = built.api.calls
    .filter((call) => call.method === "messages")
    .map((call) => call.args[0]);
  expect(visited).not.toContain("-100777");
  expect(visited).toContain("-42");
});

test("a sync with no cursor behaves exactly as a first backfill", async () => {
  const built = await connected({ now: FEBRUARY });
  const backfill = await built.connector.backfill(null);
  const sync = await built.connector.sync(null);
  expect(sync).toEqual(backfill);
});

function bulk(peer_id: string, from: number, to: number): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  for (let id = from; id <= to; id += 1) {
    messages.push({
      peer_id,
      id,
      date: LATER + id,
      text: `${peer_id} note ${id}`,
      out: false,
      service: false,
    });
  }
  return messages;
}

function twoDialogs() {
  const account = fixtureAccount();
  account.dialogs = ["1", "2"].map((peer_id) => ({
    peer_id,
    peer_type: "user" as const,
    title: "grace",
    public: false,
    top_message_id: peer_id === "1" ? 1 : 5,
  }));
  account.messages = { "1": bulk("1", 1, 1), "2": bulk("2", 1, 5) };
  return account;
}

async function settled(account = twoDialogs()) {
  const built = await connected({ account, now: FEBRUARY });
  const drained = await drain(built.connector, "backfill");
  const first = await built.connector.sync(drained.cursor);
  expect(first.events).toEqual([]);
  return { built, cursor: first.cursor as string };
}

test("an edit is still found when an earlier dialog nearly filled the batch", async () => {
  const { built, cursor } = await settled();
  const watermark = parseCursor(cursor).edit_watermark;
  for (const message of bulk("1", 2, 500)) built.api.append("1", message);
  built.api.edit("2", 5, "rewritten", watermark + 60);
  // A later pass start is what makes a missed edit permanent: the watermark
  // would move past it and nothing would look at that message again.
  built.clock.now += 300_000;

  const first = await built.connector.sync(cursor);
  expect(parseCursor(first.cursor as string).pass?.next_peer).toBe("2");
  const rest = await drain(built.connector, "sync", first.cursor);
  const seen = ids([...first.events, ...rest.events]);
  expect(seen).toContain("2:5");
  expect(parseCursor(rest.cursor).edit_watermark).toBeGreaterThan(watermark);
});

test("a dialog that fills the batch keeps the pass on itself", async () => {
  const { built, cursor } = await settled();
  for (const message of bulk("1", 2, 1201)) built.api.append("1", message);

  const sizes: number[] = [];
  let current = cursor;
  for (let round = 0; round < 4; round += 1) {
    const batch = await built.connector.sync(current);
    sizes.push(batch.events.length);
    current = batch.cursor as string;
    if (round === 0) {
      expect(parseCursor(current).pass?.next_peer).toBe("1");
    }
  }
  expect(sizes).toEqual([500, 500, 200, 0]);
  expect(parseCursor(current).pass).toBeNull();
  expect(parseCursor(current).dialogs["1"]?.last_id).toBe(1201);
});

function crowded(count: number) {
  const account = fixtureAccount();
  account.dialogs = [];
  account.messages = {};
  for (let index = 0; index < count; index += 1) {
    account.dialogs.push({
      peer_id: String(9_000_000 + index),
      peer_type: "user",
      title: "grace",
      public: false,
      top_message_id: 0,
    });
  }
  return account;
}

test("the cursor never tracks more dialogs than a listing may return", async () => {
  const built = await connected({ account: crowded(MAX_DIALOGS), now: FEBRUARY });
  const drained = await drain(built.connector, "backfill");
  expect(Object.keys(parseCursor(drained.cursor).dialogs)).toHaveLength(
    MAX_DIALOGS,
  );

  // One conversation leaves the listing page, one arrives: ordinary churn at
  // the ceiling, which used to push the cursor one entry past its own parser.
  built.api.hideDialog("9000000");
  built.api.addDialog(
    {
      peer_id: "9999999",
      peer_type: "user",
      title: "linus",
      public: false,
      top_message_id: 1,
    },
    [{ peer_id: "9999999", id: 1, date: LATER, text: "hello", out: false, service: false }],
  );

  const batch = await built.connector.sync(drained.cursor);
  const cursor = parseCursor(batch.cursor as string);
  expect(Object.keys(cursor.dialogs)).toHaveLength(MAX_DIALOGS);
  expect(cursor.dialogs["9999999"]).toBeDefined();
  expect(cursor.dialogs["9000000"]).toBeUndefined();
  expect(ids(batch.events)).toEqual(["9999999:1"]);

  // And it keeps working: the checkpoint it just wrote is still walkable.
  expect((await built.connector.sync(batch.cursor)).events).toEqual([]);
});
