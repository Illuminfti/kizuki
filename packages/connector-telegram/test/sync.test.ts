import { expect, test } from "bun:test";
import { computeContentHash } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { parseCursor } from "../src/cursor";
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
