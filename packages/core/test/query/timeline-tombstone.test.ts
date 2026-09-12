import { afterEach, expect, setSystemTime, test } from "bun:test";
import { openLedger, timeline } from "@kizuki/core/testing";
import type { CaptureEventInput } from "../../src/contracts/event";
import { registerConnection } from "../../src/ledger/connections";
import { accept, liveEventIds, readLiveEvent, readSince, replayLive } from "../../src/ledger/ledger";
import { setSourceGrant, type SourceAdmission } from "../../src/ledger/source-grants";
import { timelineAuditCandidates } from "../../src/query/timeline";
import { validEvent } from "../fixtures";

afterEach(() => setSystemTime());

function capture(
  db: ReturnType<typeof openLedger>,
  suffix: string,
  overrides: Partial<CaptureEventInput> = {},
  source?: SourceAdmission,
) {
  const result = accept(db, { ...validEvent(), ...overrides }, {
    generateId: () => `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
    ...(source === undefined ? {} : { source }),
  });
  if (result.status !== "stored") throw new Error(`synthetic capture failed: ${JSON.stringify(result)}`);
  return result.event;
}

function grant(db: ReturnType<typeof openLedger>, suffix: string): SourceAdmission {
  const source_key = `01ARZ3NDEKTSV4RRFFQ69G5FS${suffix}`;
  registerConnection(db, "fixture", source_key);
  const receipt = setSourceGrant(db, {
    source_key,
    expected_revision: 0,
    operation_id: `synthetic-grant-${source_key}`,
    policy: {
      purposes: ["capture"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
  return { source_key, expected_revision: receipt.revision };
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
    const original = capture(db, "V");
    const otherConnector = capture(db, "W", { connector_id: "other" });
    const otherRecord = capture(db, "X", { source_record_id: "other" });
    capture(db, "Y", { deleted: true });
    expect(readLiveEvent(db, original.event_id)).toBeNull();
    expect(readLiveEvent(db, otherConnector.event_id)?.event_id).toBe(otherConnector.event_id);
    expect(readLiveEvent(db, otherRecord.event_id)?.event_id).toBe(otherRecord.event_id);
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

test("deleting one granted source does not hide another source's same record id", () => {
  setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const db = openLedger(":memory:");
  try {
    const sourceA = grant(db, "A");
    const sourceB = grant(db, "B");
    const eventA = capture(db, "A", { text: "source A evidence" }, sourceA);
    const eventB = capture(db, "B", { text: "source B evidence" }, sourceB);
    expect(readSince(db, null, 10).events.map(event => event.event_id))
      .toEqual([eventA.event_id, eventB.event_id]);
    expect(readLiveEvent(db, eventA.event_id)?.event_id).toBe(eventA.event_id);
    expect(readLiveEvent(db, eventB.event_id)?.event_id).toBe(eventB.event_id);
    const tombstone = capture(db, "C", { deleted: true, text: "source A deletion" }, sourceA);
    expect(readLiveEvent(db, eventA.event_id)).toBeNull();
    expect(readLiveEvent(db, eventB.event_id)?.event_id).toBe(eventB.event_id);
    expect(readLiveEvent(db, tombstone.event_id)).toBeNull();
    expect(liveEventIds(db, [eventA.event_id, eventB.event_id, tombstone.event_id]))
      .toEqual(new Set([eventB.event_id]));
    expect(timeline(db, { ceiling: "private" }).map(row => row.event_id)).toEqual([eventB.event_id]);
    expect(timelineAuditCandidates(db, {})).toEqual([eventB.event_id]);
    expect([...replayLive(db)].map(event => event.event_id)).toEqual([eventB.event_id]);
    expect(readSince(db, null, 10).events.map(event => event.event_id))
      .toEqual([eventA.event_id, eventB.event_id, tombstone.event_id]);
  } finally { db.close(); }
});

test("a binding mismatch never cross-hides live history", () => {
  setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const db = openLedger(":memory:");
  try {
    const bound = grant(db, "A");
    const unboundLive = capture(db, "A");
    capture(db, "B", { deleted: true, text: "bound deletion" }, bound);
    const boundLive = capture(db, "C", { source_record_id: "rec-2", text: "bound evidence" }, bound);
    capture(db, "D", { source_record_id: "rec-2", deleted: true, text: "unbound deletion" });
    expect(readLiveEvent(db, unboundLive.event_id)?.event_id).toBe(unboundLive.event_id);
    expect(readLiveEvent(db, boundLive.event_id)?.event_id).toBe(boundLive.event_id);
    expect(timeline(db, { ceiling: "private" }).map(row => row.event_id))
      .toEqual([unboundLive.event_id, boundLive.event_id]);
    expect([...replayLive(db)].map(event => event.event_id))
      .toEqual([unboundLive.event_id, boundLive.event_id]);
  } finally { db.close(); }
});

test("identical payloads from two sources still report source_binding_conflict", () => {
  setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const db = openLedger(":memory:");
  try {
    const sourceA = grant(db, "A");
    const sourceB = grant(db, "B");
    const first = capture(db, "A", {}, sourceA);
    const collision = accept(db, validEvent(), {
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      source: sourceB,
    });
    expect(collision).toEqual({
      status: "error",
      error: "source_binding_conflict",
      kind: "validation",
    });
    expect(readLiveEvent(db, first.event_id)?.event_id).toBe(first.event_id);
    expect(readSince(db, null, 10).events.map(event => event.event_id)).toEqual([first.event_id]);
  } finally { db.close(); }
});
