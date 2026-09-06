import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "../src/contracts/event";
import { openLedger } from "../src/ledger/db";
import { accept, count, readSince, replay } from "../src/ledger/ledger";
import { computeContentHash } from "../src/util/hash";
import { validEvent } from "./fixtures";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function event(
  sourceRecordId: string,
  overrides: Partial<CaptureEventInput> = {},
): CaptureEventInput {
  return { ...validEvent(), source_record_id: sourceRecordId, ...overrides };
}

function storedEvent(db: Database, input: CaptureEventInput) {
  const result = accept(db, input);
  if (result.status !== "stored") {
    throw new Error(`expected stored event, got ${result.status}`);
  }
  return result.event;
}

describe("accept", () => {
  test("stores a valid input and reads it back", () => {
    const db = openLedger(":memory:");
    const input = validEvent();
    const result = accept(db, input);
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.event.event_id).toMatch(ULID);
    expect(result.event.content_hash).toBe(computeContentHash(input));
    expect(readSince(db, null, 10).events).toEqual([result.event]);
    db.close();
  });

  test("deduplicates the same source version", () => {
    const db = openLedger(":memory:");
    expect(accept(db, validEvent()).status).toBe("stored");
    expect(accept(db, validEvent())).toEqual({ status: "duplicate" });
    expect(count(db)).toBe(1);
    db.close();
  });

  test("stores an edited source record as a new event", () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, validEvent());
    const edited = storedEvent(db, { ...validEvent(), text: "the kettle boiled" });
    expect(edited.event_id).not.toBe(first.event_id);
    expect(edited.content_hash).not.toBe(first.content_hash);
    expect(count(db)).toBe(2);
    db.close();
  });

  test("round-trips nested metadata verbatim", () => {
    const db = openLedger(":memory:");
    const metadata = {
      thread: { id: "t-9", flags: ["unread", "starred"] },
      scores: [1, { confidence: 0.75 }, null],
      archived: false,
    };
    const stored = storedEvent(db, { ...validEvent(), metadata });
    expect(readSince(db, null, 1).events[0]?.metadata).toEqual(metadata);
    expect(readSince(db, null, 1).events[0]).toEqual(stored);
    db.close();
  });

  test("reports an event_id collision with different content as an error", () => {
    const db = openLedger(":memory:");
    const collidingId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(
      accept(db, event("rec-first"), { generateId: () => collidingId }).status,
    ).toBe("stored");
    const collision = accept(db, event("rec-second", { text: "different" }), {
      generateId: () => collidingId,
    });
    expect(collision.status).toBe("error");
    if (collision.status !== "error") throw new Error("unreachable");
    expect(collision.error).toContain("event_id collision");
    expect(count(db)).toBe(1);
    db.close();
  });

  test("stores and reads a tombstone", () => {
    const db = openLedger(":memory:");
    const tombstone = storedEvent(db, { ...validEvent(), deleted: true, text: "" });
    expect(tombstone.deleted).toBe(true);
    expect(readSince(db, null, 1).events[0]?.deleted).toBe(true);
    db.close();
  });

  test("omits a missing sensitivity_hint when reading", () => {
    const db = openLedger(":memory:");
    const input = validEvent();
    delete input.sensitivity_hint;
    const stored = storedEvent(db, input);
    expect("sensitivity_hint" in stored).toBe(false);
    expect("sensitivity_hint" in readSince(db, null, 1).events[0]!).toBe(false);
    db.close();
  });

  test("returns validation failures without writing", () => {
    const db = openLedger(":memory:");
    const result = accept(db, { schema: "kizuki.event/v1" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toContain("connector_id");
    expect(result.error).toContain("source_record_id");
    expect(count(db)).toBe(0);
    db.close();
  });

  test("rejects accessor metadata before creating any ledger row", () => {
    const db = openLedger(":memory:");
    let reads = 0;
    const metadata = { get token() { reads += 1; return "secret"; } };
    const result = accept(db, { ...validEvent(), metadata });
    expect(result.status).toBe("error");
    expect(reads).toBe(0);
    expect(count(db)).toBe(0);
    db.close();
  });

  test("hashes and persists one snapshot even if the caller later mutates input", () => {
    const db = openLedger(":memory:");
    const input = { ...validEvent(), metadata: { token: "first" } };
    const expectedHash = computeContentHash(input);
    const result = accept(db, input, { generateId() {
      input.text = "changed";
      input.metadata.token = "changed";
      return "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    } });
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.event.metadata).toEqual({ token: "first" });
    expect(result.event.text).not.toBe("changed");
    expect(result.event.content_hash).toBe(expectedHash);
    expect(readSince(db, null, 1).events[0]).toEqual(result.event);
    db.close();
  });

  test("rejects a generated id that is not a canonical ULID before insert", () => {
    const db = openLedger(":memory:");
    for (const id of [
      "not-a-ulid",
      "01ARZ3NDEKTSV4RRFFQ69G5FA",
      "01arz3ndektsv4rrffq69g5fav",
      "81ARZ3NDEKTSV4RRFFQ69G5FAV",
      "01ARZ3NDEKTSV4RRFFQ69G5FAI",
    ]) {
      const result = accept(db, event(`rec-${id}`), { generateId: () => id });
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("unreachable");
      expect(result.error).toContain("event_id");
      expect(result.kind).toBe("validation");
    }
    expect(count(db)).toBe(0);
    db.close();
  });
});
describe("readSince", () => {
  test("paginates 250 events without duplicates or gaps", () => {
    const db = openLedger(":memory:");
    const expected: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      expected.push(storedEvent(db, event(`rec-${index}`)).event_id);
    }
    const seen: string[] = [];
    const pageSizes: number[] = [];
    let cursor = null;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = readSince(db, cursor, 100);
      if (page.events.length > 0) {
        pageSizes.push(page.events.length);
        seen.push(...page.events.map(({ event_id }) => event_id));
      }
      cursor = page.cursor;
    }
    expect(pageSizes).toEqual([100, 100, 50]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(250);
    expect(cursor).not.toBeNull();
    const drained = readSince(db, cursor, 100);
    expect(drained.events).toEqual([]);
    expect(drained.exhausted).toBe(true);
    expect(drained.cursor).toEqual(cursor);
    db.close();
  });
});

describe("replay", () => {
  test("filters by connector, kind, and occurred_at", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("a", {
      connector_id: "mail",
      kind: "email",
      occurred_at: "2026-01-01T00:00:00Z",
    }));
    storedEvent(db, event("b", {
      connector_id: "mail",
      kind: "message",
      occurred_at: "2026-02-01T00:00:00Z",
    }));
    storedEvent(db, event("c", {
      connector_id: "chat",
      kind: "message",
      occurred_at: "2026-03-01T00:00:00Z",
    }));
    expect([...replay(db, { connector_id: "mail" })].map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["a", "b"]);
    expect([...replay(db, { kind: "message" })].map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["b", "c"]);
    expect([...replay(db, { since: "2026-02-01T00:00:00Z" })].map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["b", "c"]);
    db.close();
  });
});
