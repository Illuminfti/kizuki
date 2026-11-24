import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "../src/contracts/event";
import { openLedger } from "../src/ledger/db";
import { accept, count, countSince, laterVersionSql, latestLedgerCursor, readLiveEvent, readSince, replay, replayLive } from "../src/ledger/ledger";
import { computeOriginBinding } from "../src/ledger/event-origin-binding";
import { computeContentHash, sha256Hex } from "../src/util/hash";
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

  test("since compares offset-equivalent instants, not lexical timestamp text", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("offset-inside", {
      occurred_at: "2026-02-02T23:30:00-02:00",
    }));
    storedEvent(db, event("utc-before", {
      occurred_at: "2026-02-02T22:00:00Z",
    }));
    expect([...replay(db, { since: "2026-02-03T00:00:00Z" })].map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["offset-inside"]);
    db.close();
  });

  test("an offset-written since selects the same rows as its UTC twin", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("before", { occurred_at: "2026-02-02T16:59:59Z" }));
    storedEvent(db, event("after", { occurred_at: "2026-02-02T17:00:01Z" }));
    const utc = [...replay(db, { since: "2026-02-02T17:00:00Z" })].map(
      ({ source_record_id }) => source_record_id,
    );
    const offset = [...replay(db, { since: "2026-02-02T12:00:00-05:00" })].map(
      ({ source_record_id }) => source_record_id,
    );
    expect(utc).toEqual(["after"]);
    expect(offset).toEqual(utc);
    db.close();
  });

  test("since refuses an instant that has no RFC3339 UTC spelling", () => {
    const db = openLedger(":memory:");
    // Valid RFC3339, but the UTC equivalent falls outside year 9999.
    expect(() => [...replay(db, { since: "9999-12-31T23:59:59-14:00" })]).toThrow(
      /no RFC3339 UTC spelling/,
    );
    db.close();
  });

  test("since distinguishes nanoseconds inside one millisecond", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("before", {
      occurred_at: "2026-01-01T00:00:00.123456788Z",
    }));
    storedEvent(db, event("middle", {
      occurred_at: "2026-01-01T00:00:00.123456789Z",
    }));
    storedEvent(db, event("after", {
      occurred_at: "2026-01-01T00:00:00.123456790Z",
    }));
    expect([...replay(db, { since: "2026-01-01T00:00:00.123456789Z" })].map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["middle", "after"]);
    expect([...replay(db, {
      since: "2026-01-01T00:00:00.123456789Z",
      until: "2026-01-01T00:00:00.123456790Z",
    })].map(({ source_record_id }) => source_record_id)).toEqual(["middle"]);
    db.close();
  });
});

function insertWithAcceptedAt(
  db: Database,
  eventId: string,
  input: CaptureEventInput,
  acceptedAt: string,
): void {
  const contentHash = computeContentHash(input);
  const textHash = sha256Hex(input.text);
  const binding = computeOriginBinding(
    { event_id: eventId, content_hash_version: 2, content_hash: contentHash, text_hash: textHash, origin: "external" },
    acceptedAt,
    "capture",
    null,
  );
  db.query(
    `INSERT INTO events (
      event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
      text, subjects, sensitivity_hint, deleted, attachments, metadata,
      content_hash, accepted_at, content_hash_version, text_hash,
      origin, origin_binding_version, origin_binding_kind, origin_binding
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,2,?,'external',1,'capture',?)`,
  ).run(
    eventId,
    input.connector_id,
    input.source_record_id,
    input.kind,
    input.occurred_at,
    input.observed_at,
    input.text,
    JSON.stringify(input.subjects),
    input.sensitivity_hint ?? null,
    input.deleted ? 1 : 0,
    JSON.stringify(input.attachments),
    JSON.stringify(input.metadata),
    contentHash,
    acceptedAt,
    textHash,
    binding,
  );
}

describe("instant-based accepted_at ordering (#1072)", () => {
  test("readSince, countSince, replay, and latestLedgerCursor order mixed offsets and submillisecond fractions by instant", () => {
    const db = openLedger(":memory:");
    insertWithAcceptedAt(db, "01ARZ3NDEKTSV4RRFFQ69G5FA1", event("r1"), "2026-06-01T12:00:00Z");
    insertWithAcceptedAt(db, "01ARZ3NDEKTSV4RRFFQ69G5FA2", event("r2"), "2026-06-01T14:00:00+02:00");
    insertWithAcceptedAt(db, "01ARZ3NDEKTSV4RRFFQ69G5FA3", event("r3"), "2026-06-01T12:00:00.050000000Z");
    insertWithAcceptedAt(db, "01ARZ3NDEKTSV4RRFFQ69G5FA4", event("r4"), "2026-06-01T12:00:00.5Z");
    insertWithAcceptedAt(db, "01ARZ3NDEKTSV4RRFFQ69G5FA5", event("r5"), "2026-06-01T11:30:00-02:00");

    const expected = ["r1", "r2", "r3", "r4", "r5"];
    expect([...replay(db, {})].map(e => e.source_record_id)).toEqual(expected);

    const seen: string[] = [];
    let cursor = null;
    let remaining = 5;
    while (true) {
      expect(countSince(db, cursor)).toBe(remaining);
      const page = readSince(db, cursor, 2);
      seen.push(...page.events.map(e => e.source_record_id));
      remaining -= page.events.length;
      cursor = page.cursor;
      if (page.exhausted) break;
    }
    expect(seen).toEqual(expected);
    expect(countSince(db, cursor)).toBe(0);
    expect(latestLedgerCursor(db)).toEqual({
      accepted_at: "2026-06-01T11:30:00-02:00",
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
    });
    db.close();
  });

  test("LIVE_PREDICATE and laterVersionSql compare tombstones and edits by instant, not lexical string", () => {
    const db = openLedger(":memory:");
    const liveId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const tombId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    insertWithAcceptedAt(db, liveId, event("same-rec", { text: "v1" }), "2026-06-01T12:00:00Z");
    insertWithAcceptedAt(db, tombId, event("same-rec", { deleted: true, text: "" }), "2026-06-01T12:00:00.500Z");

    expect(readLiveEvent(db, liveId)).toBeNull();
    expect([...replayLive(db, {})]).toEqual([]);

    const v1Id = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
    const v2Id = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
    insertWithAcceptedAt(db, v1Id, event("edited-rec", { text: "first draft" }), "2026-06-01T12:00:00+02:00");
    insertWithAcceptedAt(db, v2Id, event("edited-rec", { text: "second draft" }), "2026-06-01T06:00:00-05:00");

    const currentRows = db
      .query<{ event_id: string }, []>(
        `SELECT e.event_id FROM events AS e
          WHERE e.deleted = 0
            AND NOT EXISTS (SELECT 1 FROM events AS later WHERE ${laterVersionSql("later", "e")})`,
      )
      .all();
    expect(currentRows.map(r => r.event_id)).toContain(v2Id);
    expect(currentRows.map(r => r.event_id)).not.toContain(v1Id);
    db.close();
  });
});
