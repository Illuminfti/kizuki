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

    expect(timeline(db, { day: "2026-02-03" }).map(({ event_id }) => event_id)).toEqual([
      start.event_id,
      end.event_id,
    ]);
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

    expect(timeline(db, { day: "2026-02-03" }).map(({ event_id }) => event_id)).toEqual([
      inside.event_id,
    ]);
  });

  test("includes contract-valid lowercase and leap-second timestamps", () => {
    const db = searchDb();
    const lowercase = storedEvent(db, "lowercase", {
      occurred_at: "2026-06-30t12:00:00z",
    });
    const leap = storedEvent(db, "leap", {
      occurred_at: "2026-06-30T23:59:60Z",
    });

    expect(timeline(db, { day: "2026-06-30" }).map(({ event_id }) => event_id)).toEqual([
      lowercase.event_id,
      leap.event_id,
    ]);
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
    db.query("UPDATE events SET sensitivity_hint = NULL WHERE event_id = ?").run(
      unlabeled.event_id,
    );

    expect(
      timeline(db, { ceiling: "personal" }).map(({ event_id }) => event_id),
    ).toEqual([publicEvent.event_id, personal.event_id]);
  });

  test.todo(
    "sensitivity lane: owner timeline excludes events without sensitivity",
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

  test("rejects a garbage since or until instead of returning an empty window", () => {
    const db = searchDb();
    storedEvent(db, "live");
    expect(() => timeline(db, { since: "garbage" })).toThrow(RangeError);
    expect(() => timeline(db, { until: "garbage" })).toThrow(RangeError);
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
