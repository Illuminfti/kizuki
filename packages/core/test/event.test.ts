import { describe, expect, test } from "bun:test";
import { validateEventInput } from "../src/contracts/event";
import { rawEvent, validEvent } from "./fixtures";

describe("validateEventInput accepts", () => {
  const accepted: [string, () => Record<string, unknown>][] = [
    ["a fully populated event", () => rawEvent()],
    [
      "an event with no optional sensitivity_hint",
      () => {
        const e = rawEvent();
        delete e["sensitivity_hint"];
        return e;
      },
    ],
    [
      "empty text, subjects, attachments and metadata",
      () => ({
        ...rawEvent(),
        text: "",
        subjects: [],
        attachments: [],
        metadata: {},
      }),
    ],
    ["a tombstone", () => ({ ...rawEvent(), deleted: true, text: "" })],
    [
      "a leap-second timestamp",
      () => ({ ...rawEvent(), occurred_at: "2026-06-30T23:59:60Z" }),
    ],
    [
      "a fractional-second timestamp with a negative offset",
      () => ({
        ...rawEvent(),
        occurred_at: "2026-01-02T03:04:05.123456-08:00",
      }),
    ],
    [
      "a lowercase t/z timestamp",
      () => ({ ...rawEvent(), observed_at: "2026-01-02t03:04:05z" }),
    ],
    [
      "a null-prototype metadata bag",
      () => ({ ...rawEvent(), metadata: Object.create(null) }),
    ],
    [
      "every subject role",
      () => ({
        ...rawEvent(),
        subjects: [
          { subject_id: "a", role: "about" },
          { subject_id: "b", role: "from" },
          { subject_id: "c", role: "to" },
        ],
      }),
    ],
    ...(["public", "personal", "private"] as const).map(
      (hint): [string, () => Record<string, unknown>] => [
        `sensitivity_hint "${hint}"`,
        () => ({ ...rawEvent(), sensitivity_hint: hint }),
      ],
    ),
  ];

  for (const [name, build] of accepted) {
    test(name, () => {
      const result = validateEventInput(build());
      expect(result.ok).toBe(true);
    });
  }
});

describe("validateEventInput rejects", () => {
  const rejected: [string, unknown, string][] = [
    ["a non-object", "not an event", "event"],
    ["null", null, "event"],
    ["an array", [], "event"],
    [
      "a wrong schema tag",
      { ...rawEvent(), schema: "kizuki.event/v2" },
      "schema",
    ],
    ["a missing connector_id", omit("connector_id"), "connector_id"],
    [
      "an empty connector_id",
      { ...rawEvent(), connector_id: "" },
      "connector_id",
    ],
    [
      "a missing source_record_id",
      omit("source_record_id"),
      "source_record_id",
    ],
    ["a numeric kind", { ...rawEvent(), kind: 7 }, "kind"],
    ["a missing occurred_at", omit("occurred_at"), "occurred_at"],
    [
      "a date-only occurred_at",
      { ...rawEvent(), occurred_at: "2026-01-02" },
      "occurred_at",
    ],
    [
      "month 13",
      { ...rawEvent(), occurred_at: "2026-13-01T00:00:00Z" },
      "occurred_at",
    ],
    [
      "month 00",
      { ...rawEvent(), occurred_at: "2026-00-01T00:00:00Z" },
      "occurred_at",
    ],
    [
      "February 30th",
      { ...rawEvent(), occurred_at: "2026-02-30T00:00:00Z" },
      "occurred_at",
    ],
    [
      "February 29th in a common year",
      { ...rawEvent(), occurred_at: "2027-02-29T00:00:00Z" },
      "occurred_at",
    ],
    [
      "a day-31 April",
      { ...rawEvent(), occurred_at: "2026-04-31T00:00:00Z" },
      "occurred_at",
    ],
    [
      "hour 24",
      { ...rawEvent(), occurred_at: "2026-01-01T24:00:00Z" },
      "occurred_at",
    ],
    [
      "minute 60",
      { ...rawEvent(), occurred_at: "2026-01-01T00:60:00Z" },
      "occurred_at",
    ],
    [
      "second 61",
      { ...rawEvent(), occurred_at: "2026-01-01T00:00:61Z" },
      "occurred_at",
    ],
    [
      "a missing offset",
      { ...rawEvent(), occurred_at: "2026-01-01T00:00:00" },
      "occurred_at",
    ],
    [
      "a bad offset hour",
      { ...rawEvent(), occurred_at: "2026-01-01T00:00:00+99:00" },
      "occurred_at",
    ],
    [
      "a bad offset minute",
      { ...rawEvent(), occurred_at: "2026-01-01T00:00:00+01:60" },
      "occurred_at",
    ],
    [
      "an unpadded offset",
      { ...rawEvent(), occurred_at: "2026-01-01T00:00:00+5:00" },
      "occurred_at",
    ],
    [
      "a millisecond epoch number",
      { ...rawEvent(), observed_at: 1767225600000 },
      "observed_at",
    ],
    [
      "a bad observed_at",
      { ...rawEvent(), observed_at: "yesterday" },
      "observed_at",
    ],
    ["null text", { ...rawEvent(), text: null }, "text"],
    ["subjects as an object", { ...rawEvent(), subjects: {} }, "subjects"],
    [
      "an unknown subject role",
      { ...rawEvent(), subjects: [{ subject_id: "a", role: "cc" }] },
      "subjects[0].role",
    ],
    [
      "a subject with no id",
      { ...rawEvent(), subjects: [{ role: "to" }] },
      "subjects[0].subject_id",
    ],
    [
      "a non-object subject",
      { ...rawEvent(), subjects: ["ada"] },
      "subjects[0]",
    ],
    [
      "an unknown sensitivity_hint",
      { ...rawEvent(), sensitivity_hint: "secret" },
      "sensitivity_hint",
    ],
    [
      "a null sensitivity_hint",
      { ...rawEvent(), sensitivity_hint: null },
      "sensitivity_hint",
    ],
    [
      "a stringly-typed deleted flag",
      { ...rawEvent(), deleted: "false" },
      "deleted",
    ],
    ["a missing deleted flag", omit("deleted"), "deleted"],
    [
      "attachments as a string",
      { ...rawEvent(), attachments: "none" },
      "attachments",
    ],
    [
      "an attachment with no media_type",
      { ...rawEvent(), attachments: [{ attachment_id: "a" }] },
      "attachments[0].media_type",
    ],
    [
      "a negative attachment size",
      {
        ...rawEvent(),
        attachments: [
          { attachment_id: "a", media_type: "text/plain", byte_size: -1 },
        ],
      },
      "attachments[0].byte_size",
    ],
    ["array metadata", { ...rawEvent(), metadata: [] }, "metadata"],
    ["null metadata", { ...rawEvent(), metadata: null }, "metadata"],
    ["string metadata", { ...rawEvent(), metadata: "{}" }, "metadata"],
    ["a Map as metadata", { ...rawEvent(), metadata: new Map() }, "metadata"],
    ["a Date as metadata", { ...rawEvent(), metadata: new Date() }, "metadata"],
    ["a missing metadata bag", omit("metadata"), "metadata"],
  ];

  for (const [name, input, field] of rejected) {
    test(name, () => {
      const result = validateEventInput(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.some((e) => e.startsWith(field))).toBe(true);
    });
  }
});

describe("validateEventInput normalization", () => {
  test("reports every broken field at once", () => {
    const result = validateEventInput({ schema: "kizuki.event/v1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThanOrEqual(8);
  });

  test("drops unknown keys, including a caller-supplied content_hash", () => {
    const result = validateEventInput({
      ...rawEvent(),
      content_hash: "f".repeat(64),
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rogue: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.value).sort()).toEqual([
      "attachments",
      "connector_id",
      "deleted",
      "kind",
      "metadata",
      "observed_at",
      "occurred_at",
      "schema",
      "sensitivity_hint",
      "source_record_id",
      "subjects",
      "text",
    ]);
  });

  test("omits sensitivity_hint rather than setting it undefined", () => {
    const input = rawEvent();
    delete input["sensitivity_hint"];
    const result = validateEventInput(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect("sensitivity_hint" in result.value).toBe(false);
  });

  test("round-trips a valid event unchanged", () => {
    const result = validateEventInput(validEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual(validEvent());
  });
});

function omit(key: string): Record<string, unknown> {
  const e = rawEvent();
  delete e[key];
  return e;
}
