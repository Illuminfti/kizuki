import { expect, test } from "bun:test";
import { MAX_PLAN_IDS, PurgeIndex } from "../src/plan";
import type { CaptureEventInput } from "@kizuki/core";
import { connected, drain, stateResolver } from "./helpers";
import { BATCH_LIMIT, MAX_DIALOGS } from "../src/cursor";
import { fixtureAccount } from "../src/fixture";

test("a purge plan names every record the connector emitted for a subject", async () => {
  const built = await connected();
  await drain(built.connector, "backfill");
  built.api.calls.length = 0;

  const plan = await built.connector.purgeSource("telegram:user:1002");
  expect(plan.complete).toBe(true);
  expect(plan.subject_id).toBe("telegram:user:1002");
  expect(plan.source_record_ids).toEqual([]);
  expect(plan.unreachable_source_record_ids).toEqual([
    "-100777:23",
    "-42:10",
    "1002:1",
    "1002:2",
    "1002:3",
    "1002:4",
    "1002:5",
  ]);
  expect(built.api.calls).toEqual([]);
});

test("a subject this connector never saw yields an empty plan", async () => {
  const built = await connected();
  await drain(built.connector, "backfill");
  expect(await built.connector.purgeSource("telegram:user:9999")).toEqual({
    complete: true,
    subject_id: "telegram:user:9999",
    source_record_ids: [],
    unreachable_source_record_ids: [],
  });
});

test("the retained plan is capped and keeps the newest records", () => {
  const index = new PurgeIndex();
  const total = MAX_PLAN_IDS + 5;
  for (let position = 0; position < total; position += 1) {
    index.record({
      schema: "kizuki.event/v1",
      connector_id: "kizuki.telegram",
      source_record_id: `1002:${String(position).padStart(6, "0")}`,
      kind: "message",
      occurred_at: "2026-01-02T09:00:00.000Z",
      observed_at: "2026-01-02T09:00:00.000Z",
      text: "note",
      subjects: [{ subject_id: "telegram:user:1002", role: "from" }],
      deleted: false,
      attachments: [],
      metadata: {},
    } satisfies CaptureEventInput);
  }
  expect(index.truncated("telegram:user:1002")).toBe(true);
  expect(index.truncated("telegram:user:unseen")).toBe(false);
  const kept = index.forSubject("telegram:user:1002");
  expect(kept).toHaveLength(MAX_PLAN_IDS);
  expect(kept[0]).toBe("1002:000005");
  expect(kept[kept.length - 1]).toBe(
    `1002:${String(total - 1).padStart(6, "0")}`,
  );
});

test("re-emitting a record keeps it once and marks it newest", () => {
  const index = new PurgeIndex();
  const event = (id: string): CaptureEventInput => ({
    schema: "kizuki.event/v1",
    connector_id: "kizuki.telegram",
    source_record_id: id,
    kind: "message",
    occurred_at: "2026-01-02T09:00:00.000Z",
    observed_at: "2026-01-02T09:00:00.000Z",
    text: "note",
    subjects: [{ subject_id: "telegram:user:1002", role: "from" }],
    deleted: false,
    attachments: [],
    metadata: {},
  });
  index.record(event("1002:1"));
  index.record(event("1002:2"));
  index.record(event("1002:1"));
  expect(index.forSubject("telegram:user:1002")).toEqual([
    "1002:1",
    "1002:2",
  ]);
});


function largeAccount(count: number) {
  const account = fixtureAccount();
  const peer = account.dialogs.find(dialog => dialog.peer_id === "1002")!;
  account.dialogs = [{ ...peer, top_message_id: count }];
  const sample = account.messages["1002"]![0]!;
  account.messages = { "1002": Array.from({ length: count }, (_, i) => ({ ...sample, id: i + 1, text: `Synthetic message ${i + 1}` })) };
  return account;
}

test("only uninterrupted from-null history qualifies; resumed and replayed checkpoints do not", async () => {
  const built = await connected({ account: largeAccount(BATCH_LIMIT + 5) });
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
  const first = await built.connector.backfill(null);
  expect(first.events).toHaveLength(BATCH_LIMIT);
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
  const completed = await drain(built.connector, "backfill", first.cursor);
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(true);
  const restarted = await built.restart();
  await drain(restarted, "backfill", completed.cursor);
  expect((await restarted.purgeSource("telegram:user:1002")).complete).toBe(false);
  await drain(restarted, "backfill");
  expect((await restarted.purgeSource("telegram:user:1002")).complete).toBe(true);
  await built.connector.backfill(first.cursor);
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
});

test("reconnect and a changed dialog selection invalidate prior history coverage", async () => {
  const built = await connected();
  let completed = await drain(built.connector, "backfill");
  await built.connector.connect(stateResolver());
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
  completed = await drain(built.connector, "backfill");
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(true);
  built.account.dialogs = built.account.dialogs.filter(dialog => dialog.peer_id !== "-42");
  await drain(built.connector, "sync", completed.cursor);
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
  await drain(built.connector, "backfill");
  const current = await built.connector.purgeSource("telegram:user:1002");
  expect(current.complete).toBe(true);
  expect(current.unreachable_source_record_ids).not.toContain("-42:10");
  await built.connector.close();
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
});

test("bounded retained IDs and a capped dialog listing never claim complete history", async () => {
  const built = await connected({ account: largeAccount(MAX_PLAN_IDS + 1) });
  await drain(built.connector, "backfill");
  const plan = await built.connector.purgeSource("telegram:user:1002");
  expect(plan.unreachable_source_record_ids).toHaveLength(MAX_PLAN_IDS);
  expect(plan.complete).toBe(false);
  expect(plan.continuation).toBeUndefined();
  const account = fixtureAccount(), sample = account.dialogs[0]!;
  account.dialogs = Array.from({ length: MAX_DIALOGS }, (_, i) => ({ ...sample, peer_id: String(20_000 + i), top_message_id: 0 }));
  account.messages = {};
  const capped = await connected({ account });
  await drain(capped.connector, "backfill");
  expect((await capped.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
});

test("overlapping walks cannot combine into a complete-history witness", async () => {
  const built = await connected();
  const original = built.api.messages.bind(built.api);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  built.api.messages = async function* (peer, query) {
    if (first) { first = false; entered(); await gate; }
    yield* original(peer, query);
  };
  const pending = built.connector.backfill(null);
  await waiting;
  await built.connector.backfill(null);
  release(); await pending;
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(false);
  await drain(built.connector, "backfill");
  expect((await built.connector.purgeSource("telegram:user:1002")).complete).toBe(true);
});
