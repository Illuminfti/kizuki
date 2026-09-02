import { describe, expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import {
  LEGACY_EVENTS_FIXTURE,
  LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
  fixtureMappingHash,
  fixtureRows,
} from "../src/import-legacy-events/fixture";
import { LEGACY_EVENTS_CONNECTOR_ID } from "../src/import-legacy-events/mapping";
import type { LegacyEventsMapping } from "../src/import-legacy-events/mapping";
import { MAX_TEXT_LENGTH, rowToEvent } from "../src/import-legacy-events/rows";
import type { RowSkip } from "../src/import-legacy-events/rows";
import type { LegacyRow } from "../src/import-legacy-events/source";

const OPTIONS = {
  observedAt: LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
  mappingHash: fixtureMappingHash(),
};

function convert(
  rows: LegacyRow[],
  mapping: LegacyEventsMapping = LEGACY_EVENTS_FIXTURE.mapping,
): { events: CaptureEventInput[]; skipped: RowSkip[] } {
  const events: CaptureEventInput[] = [];
  const skipped: RowSkip[] = [];
  for (const row of rows) {
    const result = rowToEvent(row, mapping, OPTIONS);
    if ("event" in result) events.push(result.event);
    else skipped.push(result.skipped);
  }
  return { events, skipped };
}

function one(values: Record<string, unknown>): CaptureEventInput {
  const result = rowToEvent(
    { position: 1, values },
    LEGACY_EVENTS_FIXTURE.mapping,
    OPTIONS,
  );
  if (!("event" in result))
    throw new Error(`skipped: ${result.skipped.reason}`);
  return result.event;
}

describe("the fixture rows", () => {
  test("nine events and three reported skips", () => {
    const { events, skipped } = convert(fixtureRows());
    expect(events).toHaveLength(9);
    expect(skipped).toEqual([
      { position: 4, reason: "kind_unmapped" },
      { position: 5, reason: "occurred_at_invalid" },
      { position: 6, reason: "source_record_id_missing" },
    ]);
  });

  test("the first message carries subjects, text and the mapping hash", () => {
    const [first] = convert(fixtureRows()).events;
    expect(first).toEqual({
      schema: "kizuki.event/v1",
      connector_id: LEGACY_EVENTS_CONNECTOR_ID,
      source_record_id: "r1",
      kind: "message",
      occurred_at: "2026-01-01T00:00:00.000Z",
      observed_at: LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
      text: "The kettle\n\nIt is on.",
      subjects: [
        { subject_id: "legacy:ada", role: "from", display_name: "Ada" },
        { subject_id: "legacy:grace", role: "to", display_name: "Grace" },
      ],
      deleted: false,
      attachments: [],
      metadata: { mapping_hash: OPTIONS.mappingHash },
    });
  });

  test("a deleted row is a tombstone with no text and no subjects", () => {
    const tombstone = convert(fixtureRows()).events.find(
      (event) => event.deleted,
    );
    expect(tombstone).toEqual({
      schema: "kizuki.event/v1",
      connector_id: LEGACY_EVENTS_CONNECTOR_ID,
      source_record_id: "r7",
      kind: "message",
      occurred_at: "2026-01-01T00:06:00.000Z",
      observed_at: LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
      text: "",
      subjects: [],
      deleted: true,
      attachments: [],
      metadata: { legacy_deleted: true, mapping_hash: OPTIONS.mappingHash },
    });
  });

  test("a split cell and a JSON array both become subjects", () => {
    const events = convert(fixtureRows()).events;
    const split = events.find((event) => event.source_record_id === "r2");
    expect(split?.subjects.map((subject) => subject.subject_id)).toEqual([
      "legacy:grace",
      "legacy:ada",
      "legacy:linus",
    ]);
    const array = events.find((event) => event.source_record_id === "r8");
    expect(array?.subjects.map((subject) => subject.subject_id)).toEqual([
      "legacy:grace",
      "legacy:ada",
      "legacy:linus",
    ]);
  });

  test("a mapped sensitivity value becomes a hint and an unmapped one does not", () => {
    const events = convert(fixtureRows()).events;
    expect(
      events.find((event) => event.source_record_id === "r2")?.sensitivity_hint,
    ).toBe("private");
    expect(
      events.find((event) => event.source_record_id === "r3")?.sensitivity_hint,
    ).toBe("public");
    expect(
      events.find((event) => event.source_record_id === "r1")?.sensitivity_hint,
    ).toBeUndefined();
  });

  test("unconsumed columns become metadata, blobs by name only", () => {
    const events = convert(fixtureRows()).events;
    const blob = events.find((event) => event.source_record_id === "r10");
    expect(blob?.metadata).toEqual({
      mapping_hash: OPTIONS.mappingHash,
      extra: "kept",
      __blobs: ["payload"],
    });
  });

  test("an over-long metadata cell is truncated and named", () => {
    const long = convert(fixtureRows()).events.find(
      (event) => event.source_record_id === "r9",
    );
    expect((long?.metadata["extra"] as string).length).toBe(16_384);
    expect(long?.metadata["__truncated"]).toEqual(["extra"]);
  });

  test("a null text column contributes nothing to the joined text", () => {
    const partial = convert(fixtureRows()).events.find(
      (event) => event.source_record_id === "r11",
    );
    expect(partial?.text).toBe("Subject only");
  });

  test("a numeric key becomes its decimal string", () => {
    const numeric = convert(fixtureRows()).events.at(-1);
    expect(numeric?.source_record_id).toBe("9007199254740991");
  });

  test("the rowid alias never reaches metadata", () => {
    const events = convert(
      fixtureRows().map((row) => ({
        ...row,
        values: { ...(row.values as Record<string, unknown>), __rowid: 7 },
      })),
    ).events;
    for (const event of events) {
      expect(event.metadata["__rowid"]).toBeUndefined();
    }
  });

  test("every fixture event passes the ingress contract", () => {
    for (const event of convert(fixtureRows()).events) {
      const validated = validateEventInput(event);
      expect(validated.ok ? [] : validated.errors).toEqual([]);
    }
  });
});

describe("bounds and shapes", () => {
  test("a text past the cap is truncated and the metadata says so", () => {
    const event = one({
      id: "long",
      type: "msg",
      ts: 1_767_225_600,
      subject: "",
      body: "b".repeat(MAX_TEXT_LENGTH + 100),
      sender: null,
      recipients: null,
      visibility: null,
      is_deleted: 0,
    });
    expect(event.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("a key past the cap is hashed, and the hash is stable", () => {
    const values = {
      id: "k".repeat(600),
      type: "msg",
      ts: 1_767_225_600,
      subject: "s",
      body: "b",
      sender: null,
      recipients: null,
      visibility: null,
      is_deleted: 0,
    };
    const first = one(values);
    expect(first.source_record_id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.metadata["__source_record_id_hashed"]).toBe(true);
    expect(one(values).source_record_id).toBe(first.source_record_id);
  });

  test("a listed metadata column set keeps only what it names", () => {
    const mapping: LegacyEventsMapping = {
      ...LEGACY_EVENTS_FIXTURE.mapping,
      metadata: { columns: ["extra"] },
    };
    const { events } = convert(
      [
        {
          position: 1,
          values: {
            id: "r",
            type: "msg",
            ts: 1_767_225_600,
            subject: "s",
            body: "b",
            sender: null,
            recipients: null,
            visibility: null,
            is_deleted: 0,
            extra: "kept",
            other: "dropped",
          },
        },
      ],
      mapping,
    );
    expect(events[0]?.metadata).toEqual({
      mapping_hash: OPTIONS.mappingHash,
      extra: "kept",
    });
  });

  test("a constant sensitivity applies to every row", () => {
    const mapping: LegacyEventsMapping = {
      ...LEGACY_EVENTS_FIXTURE.mapping,
      sensitivity_hint: { const: "private" },
    };
    const { events } = convert(fixtureRows().slice(0, 1), mapping);
    expect(events[0]?.sensitivity_hint).toBe("private");
  });

  test("a malformed line is skipped with the reader's own reason", () => {
    expect(
      convert([
        { position: 12, values: null, problem: "malformed_json" },
        { position: 20, values: null, problem: "line_too_long" },
        { position: 30, values: null },
      ]).skipped,
    ).toEqual([
      { position: 12, reason: "malformed_json" },
      { position: 20, reason: "line_too_long" },
      { position: 30, reason: "not_an_object" },
    ]);
  });

  test("an unreadable observed_at column is a skip, not a silent now", () => {
    const mapping: LegacyEventsMapping = {
      ...LEGACY_EVENTS_FIXTURE.mapping,
      observed_at: { column: "extra", format: "rfc3339" },
      metadata: { columns: [] },
    };
    expect(
      convert(
        [
          {
            position: 3,
            values: {
              id: "r",
              type: "msg",
              ts: 1_767_225_600,
              subject: "s",
              body: "b",
              sender: null,
              recipients: null,
              visibility: null,
              is_deleted: 0,
              extra: "not a timestamp",
            },
          },
        ],
        mapping,
      ).skipped,
    ).toEqual([{ position: 3, reason: "observed_at_invalid" }]);
  });
});
