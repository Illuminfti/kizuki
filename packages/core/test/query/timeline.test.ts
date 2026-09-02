import { describe, expect, test } from "bun:test";
import { timeline } from "../../src/query/timeline";
import { searchDb, storedEvent } from "../search/helpers";

describe("timeline", () => {
  test("expands a UTC day to a half-open window", () => {
    const db = searchDb();
    const start = storedEvent(db, "start", {
      occurred_at: "2026-02-03T00:00:00Z",
    });
    const end = storedEvent(db, "end", {
      occurred_at: "2026-02-03T23:59:59Z",
    });
    storedEvent(db, "next", { occurred_at: "2026-02-04T00:00:00Z" });

    expect(
      timeline(db, { day: "2026-02-03" }).map(({ event_id }) => event_id),
    ).toEqual([start.event_id, end.event_id]);
  });

  test("rejects a calendar date that does not exist", () => {
    expect(() => timeline(searchDb(), { day: "2026-02-30" })).toThrow(
      RangeError,
    );
  });

  test("normalizes valid RFC3339 offsets into the UTC day window", () => {
    const db = searchDb();
    const inside = storedEvent(db, "inside", {
      occurred_at: "2026-02-02T23:30:00-02:00",
    });
    storedEvent(db, "outside", {
      occurred_at: "2026-02-03T23:30:00-02:00",
    });

    expect(
      timeline(db, { day: "2026-02-03" }).map(({ event_id }) => event_id),
    ).toEqual([inside.event_id]);
  });

  test("includes contract-valid lowercase and leap-second timestamps", () => {
    const db = searchDb();
    const lowercase = storedEvent(db, "lowercase", {
      occurred_at: "2026-06-30t12:00:00z",
    });
    const leap = storedEvent(db, "leap", {
      occurred_at: "2026-06-30T23:59:60Z",
    });

    expect(
      timeline(db, { day: "2026-06-30" }).map(({ event_id }) => event_id),
    ).toEqual([lowercase.event_id, leap.event_id]);
  });

  test("filters subjects through the stored JSON array", () => {
    const db = searchDb();
    storedEvent(db, "ada", {
      subjects: [{ subject_id: "person:ada", role: "about" }],
    });
    const grace = storedEvent(db, "grace", {
      subjects: [{ subject_id: "person:grace", role: "about" }],
    });

    expect(
      timeline(db, { subject: "person:grace" }).map(({ event_id }) => event_id),
    ).toEqual([grace.event_id]);
  });

  test("a personal ceiling hides private and unlabeled events", () => {
    const db = searchDb();
    const publicEvent = storedEvent(db, "public", {
      sensitivity_hint: "public",
    });
    const personal = storedEvent(db, "personal", {
      sensitivity_hint: "personal",
    });
    storedEvent(db, "private", { sensitivity_hint: "private" });
    const unlabeledInput = {
      occurred_at: "2026-03-01T00:00:00Z",
    };
    const unlabeled = storedEvent(db, "unlabeled", unlabeledInput);
    db.query(
      "UPDATE events SET sensitivity_hint = NULL WHERE event_id = ?",
    ).run(unlabeled.event_id);

    expect(
      timeline(db, { ceiling: "personal" }).map(({ event_id }) => event_id),
    ).toEqual([publicEvent.event_id, personal.event_id]);
  });

  test.todo(
    "sensitivity lane: owner timeline excludes events without sensitivity",
    () => {
      const db = searchDb();
      const event = storedEvent(db, "unlabeled", {
        occurred_at: "2026-03-01T00:00:00Z",
      });
      db.query(
        "UPDATE events SET sensitivity_hint = NULL WHERE event_id = ?",
      ).run(event.event_id);

      expect(timeline(db).map(({ event_id }) => event_id)).not.toContain(
        event.event_id,
      );
    },
  );

  test("filters connector, kind, since, and until together", () => {
    const db = searchDb();
    storedEvent(db, "early", {
      connector_id: "mail",
      kind: "email",
      occurred_at: "2026-01-01T00:00:00Z",
    });
    const matching = storedEvent(db, "matching", {
      connector_id: "mail",
      kind: "email",
      occurred_at: "2026-02-01T00:00:00Z",
    });
    storedEvent(db, "other-kind", {
      connector_id: "mail",
      kind: "message",
      occurred_at: "2026-02-01T00:00:00Z",
    });

    expect(
      timeline(db, {
        connector_id: "mail",
        kind: "email",
        since: "2026-01-15T00:00:00Z",
        until: "2026-03-01T00:00:00Z",
      }).map(({ event_id }) => event_id),
    ).toEqual([matching.event_id]);
  });

  test("applies the limit after stable occurred_at and event_id ordering", () => {
    const db = searchDb();
    const first = storedEvent(db, "first", {
      occurred_at: "2026-01-01T00:00:00Z",
    });
    storedEvent(db, "second", { occurred_at: "2026-02-01T00:00:00Z" });

    expect(timeline(db, { limit: 1 }).map(({ event_id }) => event_id)).toEqual([
      first.event_id,
    ]);
  });

  test("excludes tombstones", () => {
    const db = searchDb();
    storedEvent(db, "live");
    storedEvent(db, "deleted", { deleted: true });
    expect(timeline(db)).toHaveLength(1);
  });

  test("collapses preview whitespace and bounds it to 160 characters", () => {
    const db = searchDb();
    storedEvent(db, "preview", {
      text: `  alpha\n\tbeta   ${"x".repeat(200)}  `,
    });

    const [entry] = timeline(db);
    expect(entry?.text_preview.startsWith("alpha beta xxx")).toBe(true);
    expect(entry?.text_preview).toHaveLength(160);
  });

  test("orders by instant, not the raw occurred_at string", () => {
    const db = searchDb();
    const laterOffset = storedEvent(db, "later-offset", {
      occurred_at: "2026-02-03T00:00:00-05:00",
    });
    const earlierUtc = storedEvent(db, "earlier-utc", {
      occurred_at: "2026-02-03T03:00:00Z",
    });

    expect(timeline(db).map(({ event_id }) => event_id)).toEqual([
      earlierUtc.event_id,
      laterOffset.event_id,
    ]);
  });

  test("orders and windows an offset SQLite cannot parse by its real instant", () => {
    const db = searchDb();
    const early = storedEvent(db, "early", {
      occurred_at: "2026-02-03T01:00:00Z",
    });
    const mid = storedEvent(db, "mid", { occurred_at: "2026-02-03T08:00:00Z" });
    // 2026-02-04T14:00+15:00 is 2026-02-03T23:00Z: the latest of the three,
    // written with an offset the frozen event contract accepts.
    const latest = storedEvent(db, "far-offset", {
      occurred_at: "2026-02-04T14:00:00+15:00",
    });

    expect(timeline(db).map(({ event_id }) => event_id)).toEqual([
      early.event_id,
      mid.event_id,
      latest.event_id,
    ]);
    expect(
      timeline(db, { day: "2026-02-03" }).map(({ event_id }) => event_id),
    ).toEqual([early.event_id, mid.event_id, latest.event_id]);
    expect(
      timeline(db, { since: "2026-02-03T20:00:00Z" }).map(
        ({ event_id }) => event_id,
      ),
    ).toEqual([latest.event_id]);
    expect(
      timeline(db, { until: "2026-02-03T20:00:00Z" }).map(
        ({ event_id }) => event_id,
      ),
    ).toEqual([early.event_id, mid.event_id]);
  });

  test("compares a fraction finer than a millisecond against the column", () => {
    const db = searchDb();
    const stored = storedEvent(db, "sub-milli", {
      occurred_at: "2026-02-03T12:00:00.1230Z",
    });

    expect(
      timeline(db, { until: "2026-02-03T12:00:00.1235Z" }).map(
        ({ event_id }) => event_id,
      ),
    ).toEqual([stored.event_id]);
    expect(timeline(db, { since: "2026-02-03T12:00:00.1235Z" })).toEqual([]);
  });

  test("sorts an instant it cannot evaluate last, not first", () => {
    const db = searchDb();
    const first = storedEvent(db, "first", {
      occurred_at: "2026-02-03T01:00:00Z",
    });
    // Written past the contract on purpose: `accept` refuses this, so the row
    // is inserted directly. The order still has to be total.
    db.query<never, []>(
      `INSERT INTO events (
         event_id, connector_id, source_record_id, kind, occurred_at,
         observed_at, text, subjects, sensitivity_hint, deleted, attachments,
         metadata, content_hash, accepted_at
       ) VALUES ('E${"0".repeat(25)}', 'acme', 'unparsable', 'message',
                'not-a-timestamp', '2026-02-03T00:00:00Z', 'body', '[]',
                'personal', 0, '[]', '{}', '${"h".repeat(64)}',
                '2026-02-03T00:00:00Z')`,
    ).run();

    expect(timeline(db).map(({ event_id }) => event_id)).toEqual([
      first.event_id,
      `E${"0".repeat(25)}`,
    ]);
    expect(
      timeline(db, { since: "2020-01-01T00:00:00Z" }).map(
        ({ event_id }) => event_id,
      ),
    ).toEqual([first.event_id]);
  });

  test("rejects a garbage since or until instead of returning an empty window", () => {
    const db = searchDb();
    storedEvent(db, "live");
    expect(() => timeline(db, { since: "garbage" })).toThrow(RangeError);
    expect(() => timeline(db, { until: "garbage" })).toThrow(RangeError);
    // A zero limit is an empty answer, not a reason to skip validation.
    expect(() => timeline(db, { limit: 0, since: "garbage" })).toThrow(RangeError);
    expect(() => timeline(db, { limit: 0, day: "2026-02-30" })).toThrow(RangeError);
  });

  test("accepts a fractional leap second echoed back from an entry as a bound", () => {
    const db = searchDb();
    const stored = storedEvent(db, "fractional-leap", {
      occurred_at: "2026-06-30T23:59:60.500Z",
    });
    const echoed = timeline(db)[0]?.occurred_at ?? "";
    expect(echoed).toBe(stored.occurred_at);

    expect(
      timeline(db, { since: echoed }).map(({ event_id }) => event_id),
    ).toEqual([stored.event_id]);
    expect(timeline(db, { until: echoed })).toEqual([]);
  });

  test("does not split a trailing emoji into a lone UTF-16 surrogate", () => {
    const db = searchDb();
    storedEvent(db, "emoji", { text: `${"x".repeat(159)}\u{1F600}` });

    const preview = timeline(db)[0]?.text_preview ?? "";
    expect(preview.charCodeAt(preview.length - 1)).not.toBe(0xd83d);
    expect([...preview]).toEqual([...("x".repeat(159) + "\u{1F600}")]);
  });

  test("returns subject ids rather than raw subject objects", () => {
    const db = searchDb();
    storedEvent(db, "subjects", {
      subjects: [
        { subject_id: "person:ada", role: "from" },
        { subject_id: "person:grace", role: "to" },
      ],
    });
    expect(timeline(db)[0]?.subjects).toEqual(["person:ada", "person:grace"]);
  });
});
