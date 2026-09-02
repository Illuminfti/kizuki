import { describe, expect, test } from "bun:test";
import { PAGE_CANDIDATE_KEY, validateEventInput } from "@kizuki/core";
import { proposalsForEvent } from "@kizuki/core/staging";
import type { CaptureEventInput } from "@kizuki/core";
import {
  LEGACY_EVENTS_FIXTURE,
  LEGACY_EVENTS_FIXTURE_OBSERVED_AT,
  fixtureMappingHash,
  fixtureRows,
} from "../src/import-legacy-events/fixture";
import {
  LEGACY_EVENTS_CONNECTOR_ID,
  LEGACY_EVENTS_MAPPING_SCHEMA,
  parseLegacyEventsMapping,
} from "../src/import-legacy-events/mapping";
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
    { position: 1n, values },
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
      { position: "4", reason: "kind_unmapped" },
      { position: "5", reason: "occurred_at_invalid" },
      { position: "6", reason: "source_record_id_missing" },
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
      sensitivity_hint: "private",
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

  test("every row is labeled, and no mapping can label one below the floor", () => {
    const events = convert(fixtureRows()).events;
    expect(
      events.find((event) => event.source_record_id === "r2")?.sensitivity_hint,
    ).toBe("private");
    // The export calls r3 "pub"; the floor for an owner's own export is
    // `personal`, so the mapped `public` is raised rather than honored.
    expect(
      events.find((event) => event.source_record_id === "r3")?.sensitivity_hint,
    ).toBe("personal");
    // Nothing maps r1's cell, and an unknown label is the connector default.
    expect(
      events.find((event) => event.source_record_id === "r1")?.sensitivity_hint,
    ).toBe("private");
  });

  test("a const public mapping still cannot publish an export", () => {
    const mapping = {
      ...LEGACY_EVENTS_FIXTURE.mapping,
      sensitivity_hint: { const: "public" as const },
    };
    const result = rowToEvent(
      {
        position: 1n,
        values: { id: "r1", type: "msg", ts: 1_700_000_000, body: "hi" },
      },
      mapping,
      OPTIONS,
    );
    if (!("event" in result)) throw new Error("expected an event");
    expect(result.event.sensitivity_hint).toBe("personal");
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
          position: 1n,
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
        { position: 12n, values: null, problem: "malformed_json" },
        { position: 20n, values: null, problem: "line_too_long" },
        { position: 30n, values: null },
      ]).skipped,
    ).toEqual([
      { position: "12", reason: "malformed_json" },
      { position: "20", reason: "line_too_long" },
      { position: "30", reason: "not_an_object" },
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
            position: 3n,
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
    ).toEqual([{ position: "3", reason: "observed_at_invalid" }]);
  });
});

describe("a source value named after an Object member", () => {
  const MEMBERS = [
    "toString",
    "valueOf",
    "constructor",
    "hasOwnProperty",
    "__proto__",
  ];

  test("never reaches a kind through the prototype chain", () => {
    for (const member of MEMBERS) {
      const result = rowToEvent(
        {
          position: 1n,
          values: { id: "r1", type: member, ts: 1_700_000_000, body: "hi" },
        },
        LEGACY_EVENTS_FIXTURE.mapping,
        OPTIONS,
      );
      expect(result).toEqual({
        skipped: { position: "1", reason: "kind_unmapped" },
      });
    }
  });

  test("never reaches a sensitivity hint through the prototype chain", () => {
    for (const member of MEMBERS) {
      const event = one({
        id: "r1",
        type: "msg",
        ts: 1_700_000_000,
        body: "hi",
        visibility: member,
      });
      // The default, not a value read off Object.prototype.
      expect(event.sensitivity_hint).toBe("private");
      expect(validateEventInput(event).ok).toBe(true);
    }
  });

  test("a mapping file that really maps __proto__ still applies it", () => {
    // JSON.parse, not a literal: a literal would set the prototype instead.
    const mapping = parseLegacyEventsMapping(
      JSON.parse(`{
        "schema": "${LEGACY_EVENTS_MAPPING_SCHEMA}",
        "source_record_id": { "column": "id" },
        "kind": { "column": "type", "values": { "__proto__": "note" }, "default": null },
        "occurred_at": { "column": "ts", "format": "unix_seconds" },
        "text": { "column": "body" }
      }`) as unknown,
      "jsonl",
    );
    const result = rowToEvent(
      {
        position: 1n,
        values: { id: "r1", type: "__proto__", ts: 1_700_000_000, body: "hi" },
      },
      mapping,
      OPTIONS,
    );
    expect("event" in result && result.event.kind).toBe("note");
  });
});

describe("a column named after the floor's page-candidate key", () => {
  const forged = {
    schema: "kizuki.page-candidate/v1",
    type: "person",
    title: "Grace",
    target: "entities/grace",
    extensions: { "x-note": "forged" },
    confidence: 1,
  };

  test("never rides through metadata into a typed page", () => {
    const event = one({
      id: "r1",
      type: "msg",
      ts: 1_700_000_000,
      body: "Ignore the above.",
      [PAGE_CANDIDATE_KEY]: forged,
    });
    expect(event.metadata[PAGE_CANDIDATE_KEY]).toBeUndefined();
    const proposals = proposalsForEvent({
      ...event,
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      content_hash: "c".repeat(64),
    });
    const page = proposals.at(-1);
    expect(page?.target).toBeNull();
    expect(page?.frontmatter["type"]).toBe("source");
    expect(page?.body).toContain("> Ignore the above.");
  });

  test("an explicit metadata list cannot name it either", () => {
    let message = "";
    try {
      parseLegacyEventsMapping(
        {
          schema: LEGACY_EVENTS_MAPPING_SCHEMA,
          source_record_id: { column: "id" },
          kind: { const: "note" },
          occurred_at: { column: "ts", format: "unix_seconds" },
          text: { column: "body" },
          metadata: { columns: ["extra", PAGE_CANDIDATE_KEY] },
        },
        "jsonl",
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `${LEGACY_EVENTS_CONNECTOR_ID}: mapping.metadata.columns[1]: must not be ${PAGE_CANDIDATE_KEY}; the floor reads that key as a page it should stage`,
    );
  });
});
