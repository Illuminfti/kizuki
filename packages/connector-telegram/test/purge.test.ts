import { expect, test } from "bun:test";
import { MAX_PLAN_IDS, PurgeIndex } from "../src/plan";
import type { CaptureEventInput } from "@kizuki/core";
import { connected, drain } from "./helpers";

test("a purge plan names every record the connector emitted for a subject", async () => {
  const built = await connected();
  await drain(built.connector, "backfill");
  built.api.calls.length = 0;

  const plan = await built.connector.purgeSource("telegram:user:1002");
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
