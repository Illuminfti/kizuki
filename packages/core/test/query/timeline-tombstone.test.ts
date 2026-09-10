import { afterEach, expect, setSystemTime, test } from "bun:test";
import { openLedger, timeline } from "@kizuki/core/testing";
import type { CaptureEventInput } from "../../src/contracts/event";
import { accept, readSince, replayLive } from "../../src/ledger/ledger";
import { timelineAuditCandidates } from "../../src/query/timeline";
import { validEvent } from "../fixtures";

afterEach(() => setSystemTime());

function capture(db: ReturnType<typeof openLedger>, suffix: string, overrides: Partial<CaptureEventInput> = {}) {
  const result = accept(db, { ...validEvent(), ...overrides }, {
    generateId: () => `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
  });
  if (result.status !== "stored") throw new Error(`synthetic capture failed: ${JSON.stringify(result)}`);
  return result.event;
}

for (const ceiling of ["public", "personal", "private"] as const) {
  test(`direct ${ceiling} timeline suppresses deleted history before filters and limit`, () => {
    setSystemTime(new Date("2026-09-07T00:00:00Z"));
    const db = openLedger(":memory:");
    try {
      capture(db, "V", { sensitivity_hint: "public" });
      capture(db, "W", { sensitivity_hint: "public", text: "revised synthetic text" });
      const surviving = capture(db, "X", { source_record_id: "surviving", sensitivity_hint: "public" });
      // The deletion is outside every visible filter and above two ceilings.
      // Filtering the tombstone before deciding liveness would expose history.
      capture(db, "Y", { deleted: true, kind: "deletion", subjects: [], sensitivity_hint: "private",
        occurred_at: "2026-03-02T00:00:00Z", observed_at: "2020-01-01T00:00:00Z" });
      const options = { ceiling, day: "2026-02-28", kind: "message", subject: "person:ada", limit: 1 };
      expect(timeline(db, options).map(row => row.event_id)).toEqual([surviving.event_id]);
      expect(timelineAuditCandidates(db, options)).toEqual([surviving.event_id]);
      expect(readSince(db, null, 10).events).toHaveLength(4);
    } finally { db.close(); }
  });
}

test("timeline scopes a tombstone to its connector and source record", () => {
  setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const db = openLedger(":memory:");
  try {
    capture(db, "V");
    const otherConnector = capture(db, "W", { connector_id: "other" });
    const otherRecord = capture(db, "X", { source_record_id: "other" });
    capture(db, "Y", { deleted: true });
    expect(timeline(db, { ceiling: "private" }).map(row => row.event_id))
      .toEqual([otherConnector.event_id, otherRecord.event_id]);
  } finally { db.close(); }
});

test("a live revision accepted after a tombstone remains visible without reviving predecessors", () => {
  setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const db = openLedger(":memory:");
  try {
    capture(db, "V");
    capture(db, "W", { deleted: true });
    const restored = capture(db, "X", { text: "restored synthetic source" });
    const result = timeline(db, { ceiling: "private" }).map(row => row.event_id);
    expect(result).toEqual([restored.event_id]);
    expect(result).toEqual([...replayLive(db)].map(event => event.event_id));
    expect(readSince(db, null, 10).events).toHaveLength(3);
  } finally { db.close(); }
});

test("timeline uses accepted time before event ID and ignores provider timestamps for deletion order", () => {
  const db = openLedger(":memory:");
  try {
    setSystemTime(new Date("2026-09-07T00:00:00Z"));
    capture(db, "Z", { observed_at: "2030-01-01T00:00:00Z" });
    setSystemTime(new Date("2026-09-07T00:00:01Z"));
    capture(db, "V", { deleted: true, observed_at: "2020-01-01T00:00:00Z" });
    expect(timeline(db, { ceiling: "private" })).toEqual([]);
    expect(timelineAuditCandidates(db, {})).toEqual([]);
    expect([...replayLive(db)]).toEqual([]);
  } finally { db.close(); }
});
