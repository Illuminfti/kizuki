import { describe, expect, test } from "bun:test";
import { KizukiError } from "../src/errors";
import {
  IDENTIFIER,
  LEGACY_EVENTS_CONNECTOR_ID,
  LEGACY_EVENTS_MAPPING_SCHEMA,
  kindsOf,
  parseLegacyEventsMapping,
} from "../src/import-legacy-events/mapping";
import { LEGACY_EVENTS_FIXTURE } from "../src/import-legacy-events/fixture";

function mapping(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: LEGACY_EVENTS_MAPPING_SCHEMA,
    table: "events",
    source_record_id: { column: "id" },
    kind: { const: "message" },
    occurred_at: { column: "ts", format: "unix_seconds" },
    text: { column: "body" },
    ...overrides,
  };
}

function refusal(raw: unknown, format: "sqlite" | "jsonl" = "sqlite"): string {
  try {
    parseLegacyEventsMapping(raw, format);
  } catch (error) {
    if (!(error instanceof KizukiError)) throw error;
    expect(error.code).toBe("misconfigured");
    return error.message.replace(`${LEGACY_EVENTS_CONNECTOR_ID}: `, "");
  }
  throw new Error("expected the mapping to be refused");
}

describe("parseLegacyEventsMapping", () => {
  test("fills in the optional halves and keeps the required ones", () => {
    expect(parseLegacyEventsMapping(mapping(), "sqlite")).toEqual({
      schema: LEGACY_EVENTS_MAPPING_SCHEMA,
      table: "events",
      source_record_id: { column: "id" },
      kind: { const: "message" },
      occurred_at: { column: "ts", format: "unix_seconds" },
      observed_at: null,
      text: { column: "body" },
      subjects: [],
      sensitivity_hint: null,
      deleted: null,
      metadata: { columns: "rest" },
    });
  });

  test("sqlite requires a table and jsonl refuses one", () => {
    expect(refusal(mapping({ table: undefined }))).toBe(
      "mapping.table: is required for sqlite",
    );
    expect(refusal(mapping(), "jsonl")).toBe(
      "mapping.table: must be absent for jsonl",
    );
    expect(
      parseLegacyEventsMapping(mapping({ table: undefined }), "jsonl").table,
    ).toBeNull();
  });

  test("column names are a bounded identifier, checked everywhere", () => {
    expect(refusal(mapping({ source_record_id: { column: "id; DROP" } }))).toBe(
      `mapping.source_record_id.column: must match ${IDENTIFIER.toString()}`,
    );
    expect(refusal(mapping({ table: 'events"; DROP TABLE x; --' }))).toContain(
      "mapping.table: must match",
    );
    expect(
      refusal(mapping({ text: { columns: ["body", "a b"], join: " " } })),
    ).toContain("mapping.text.columns[1]: must match");
  });

  test("the rowid alias may not be claimed by a source column", () => {
    expect(refusal(mapping({ source_record_id: { column: "__rowid" } }))).toBe(
      "mapping.source_record_id.column: must not be __rowid",
    );
  });

  test("a column may fill only one role", () => {
    expect(
      refusal(
        mapping({
          text: { column: "id" },
        }),
      ),
    ).toBe("mapping: column id is consumed twice");
    expect(
      parseLegacyEventsMapping(
        mapping({
          subjects: [
            { column: "who", role: "from", namespace: "legacy" },
            { column: "who", role: "to", namespace: "legacy" },
          ],
        }),
        "sqlite",
      ).subjects,
    ).toHaveLength(2);
  });

  test("kinds must be a bounded lowercase token", () => {
    expect(refusal(mapping({ kind: { const: "Message" } }))).toContain(
      "mapping.kind.const: must match",
    );
    expect(
      refusal(mapping({ kind: { column: "type", values: { m: "MSG" } } })),
    ).toContain("mapping.kind.values.m: must match");
  });

  test("unknown keys are refused at every depth", () => {
    expect(refusal(mapping({ nope: 1 }))).toBe("mapping: unknown key nope");
    expect(
      refusal(mapping({ occurred_at: { column: "ts", fmt: "date" } })),
    ).toBe("mapping.occurred_at: unknown key fmt");
  });

  test("the deleted rule needs at least one true value", () => {
    expect(
      refusal(mapping({ deleted: { column: "is_deleted", true_values: [] } })),
    ).toBe("mapping.deleted.true_values: must be a non-empty array of scalars");
  });

  test("a join longer than the cap is refused", () => {
    expect(
      refusal(mapping({ text: { columns: ["body"], join: "---------" } })),
    ).toBe("mapping.text.join: must be a string of at most 8 characters");
  });

  test("subject namespaces and roles are checked", () => {
    expect(
      refusal(
        mapping({
          subjects: [{ column: "who", role: "cc", namespace: "legacy" }],
        }),
      ),
    ).toBe("mapping.subjects[0].role: must be one of about | from | to");
    expect(
      refusal(
        mapping({
          subjects: [{ column: "who", role: "to", namespace: "Legacy" }],
        }),
      ),
    ).toContain("mapping.subjects[0].namespace: must match");
  });
});

describe("kindsOf", () => {
  test("a constant kind is the only kind", () => {
    expect(kindsOf(parseLegacyEventsMapping(mapping(), "sqlite"))).toEqual([
      "message",
    ]);
  });

  test("a mapped column reports its values and its default", () => {
    expect(kindsOf(LEGACY_EVENTS_FIXTURE.mapping)).toEqual(["message", "note"]);
    expect(
      kindsOf(
        parseLegacyEventsMapping(
          mapping({
            kind: { column: "type", values: { m: "message" }, default: "note" },
          }),
          "sqlite",
        ),
      ),
    ).toEqual(["message", "note"]);
  });
});
