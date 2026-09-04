import { describe, expect, test } from "bun:test";
import { EVENT_LIMITS, validateEventInput } from "../src/contracts/event";
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
    [
      "an unsafe attachment size",
      {
        ...rawEvent(),
        attachments: [
          {
            attachment_id: "a",
            media_type: "text/plain",
            byte_size: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      },
      "attachments[0].byte_size",
    ],
    [
      "a scientific-notation attachment size above the safe integer range",
      {
        ...rawEvent(),
        attachments: [
          { attachment_id: "a", media_type: "text/plain", byte_size: 1e21 },
        ],
      },
      "attachments[0].byte_size",
    ],
    [
      "a fractional attachment size",
      {
        ...rawEvent(),
        attachments: [
          { attachment_id: "a", media_type: "text/plain", byte_size: 1.5 },
        ],
      },
      "attachments[0].byte_size",
    ],
    [
      "duplicate subject_id and role",
      {
        ...rawEvent(),
        subjects: [
          { subject_id: "person:ada", role: "from", display_name: "Ada" },
          { subject_id: "person:ada", role: "from", display_name: "A." },
        ],
      },
      "subjects",
    ],
    [
      "duplicate identical subject refs",
      {
        ...rawEvent(),
        subjects: [
          { subject_id: "person:ada", role: "from" },
          { subject_id: "person:ada", role: "from" },
        ],
      },
      "subjects",
    ],
    [
      "duplicate attachment_id",
      {
        ...rawEvent(),
        attachments: [
          { attachment_id: "att-1", media_type: "image/png", byte_size: 12 },
          { attachment_id: "att-1", media_type: "image/jpeg", byte_size: 24 },
        ],
      },
      "attachments",
    ],
    [
      "duplicate identical attachment refs",
      {
        ...rawEvent(),
        attachments: [
          { attachment_id: "att-1", media_type: "image/png" },
          { attachment_id: "att-1", media_type: "image/png" },
        ],
      },
      "attachments",
    ],
    [
      "a caller-supplied content_hash",
      { ...rawEvent(), content_hash: "f".repeat(64) },
      "event",
    ],
    [
      "a caller-supplied event_id",
      { ...rawEvent(), event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      "event",
    ],
    ["a rogue top-level key", { ...rawEvent(), rogue: true }, "event"],
    ["a typo connectorid key", { ...rawEvent(), connectorid: "x" }, "event"],
    [
      "a future extension field",
      { ...rawEvent(), occurred_at_tz: "UTC" },
      "event",
    ],
    [
      "nested metadata Date",
      { ...rawEvent(), metadata: { when: new Date("2026-01-01T00:00:00Z") } },
      "metadata.when",
    ],
    [
      "nested metadata Map",
      { ...rawEvent(), metadata: { bag: new Map() } },
      "metadata.bag",
    ],
    [
      "nested metadata BigInt",
      { ...rawEvent(), metadata: { n: 1n } },
      "metadata.n",
    ],
    [
      "nested metadata undefined",
      { ...rawEvent(), metadata: { gap: undefined } },
      "metadata.gap",
    ],
    [
      "nested metadata function",
      { ...rawEvent(), metadata: { fn: () => 1 } },
      "metadata.fn",
    ],
    [
      "non-finite metadata number",
      { ...rawEvent(), metadata: { n: Number.POSITIVE_INFINITY } },
      "metadata.n",
    ],
    [
      "NaN metadata number",
      { ...rawEvent(), metadata: { n: Number.NaN } },
      "metadata.n",
    ],
    [
      "a __proto__ metadata key",
      { ...rawEvent(), metadata: protoBag("__proto__", 1) },
      "metadata",
    ],
    [
      "a constructor metadata key",
      { ...rawEvent(), metadata: protoBag("constructor", 1) },
      "metadata",
    ],
    [
      "a prototype metadata key",
      { ...rawEvent(), metadata: protoBag("prototype", 1) },
      "metadata",
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

  test("rejects unknown keys, including a caller-supplied content_hash", () => {
    const result = validateEventInput({
      ...rawEvent(),
      content_hash: "f".repeat(64),
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rogue: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((error) => error.includes('"content_hash"'))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.includes('"event_id"'))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.includes('"rogue"'))).toBe(true);
  });

  test("snapshots metadata so later mutation cannot change the accepted value", () => {
    const metadata: Record<string, unknown> = { unread: true };
    const result = validateEventInput({ ...rawEvent(), metadata });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    metadata["unread"] = false;
    metadata["extra"] = 1;
    expect(result.value.metadata).toEqual({ unread: true });
    expect(Object.getPrototypeOf(result.value.metadata)).toBeNull();
  });

  test("reads accessors once into plain data", () => {
    let reads = 0;
    const metadata = {
      get token() {
        reads += 1;
        return reads === 1 ? "first" : "second";
      },
    };
    const result = validateEventInput({ ...rawEvent(), metadata });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.metadata).toEqual({ token: "first" });
    expect(reads).toBe(1);
    expect(result.value.metadata["token"]).toBe("first");
    expect(reads).toBe(1);
  });

  test("accepts the same subject_id under different roles", () => {
    const result = validateEventInput({
      ...rawEvent(),
      subjects: [
        { subject_id: "person:ada", role: "from" },
        { subject_id: "person:ada", role: "about" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts a scientific-notation byte_size that is a safe integer", () => {
    const result = validateEventInput({
      ...rawEvent(),
      attachments: [
        { attachment_id: "a", media_type: "text/plain", byte_size: 1e3 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.attachments[0]?.byte_size).toBe(1000);
  });

  test("accepts attachment byte_size at the explicit maximum", () => {
    const result = validateEventInput({
      ...rawEvent(),
      attachments: [
        {
          attachment_id: "a",
          media_type: "text/plain",
          byte_size: EVENT_LIMITS.attachmentByteSizeMax,
        },
      ],
    });
    expect(result.ok).toBe(true);
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

describe("validateEventInput resource limits", () => {
  const limitCases: [string, () => Record<string, unknown>, string][] = [
    [
      "connector_id at the byte limit",
      () => ({ ...rawEvent(), connector_id: "c".repeat(EVENT_LIMITS.identifierBytes) }),
      "",
    ],
    [
      "connector_id one byte over the limit",
      () => ({
        ...rawEvent(),
        connector_id: "c".repeat(EVENT_LIMITS.identifierBytes + 1),
      }),
      "connector_id",
    ],
    [
      "source_record_id one byte over the limit",
      () => ({
        ...rawEvent(),
        source_record_id: "s".repeat(EVENT_LIMITS.identifierBytes + 1),
      }),
      "source_record_id",
    ],
    [
      "kind one byte over the limit",
      () => ({ ...rawEvent(), kind: "k".repeat(EVENT_LIMITS.identifierBytes + 1) }),
      "kind",
    ],
    [
      "text at the byte limit",
      () => ({ ...rawEvent(), text: "t".repeat(EVENT_LIMITS.textBytes) }),
      "",
    ],
    [
      "text one byte over the limit",
      () => ({ ...rawEvent(), text: "t".repeat(EVENT_LIMITS.textBytes + 1) }),
      "text",
    ],
    [
      "too many subjects",
      () => ({
        ...rawEvent(),
        subjects: Array.from({ length: EVENT_LIMITS.subjectCount + 1 }, (_, i) => ({
          subject_id: `s${i}`,
          role: "about",
        })),
      }),
      "subjects",
    ],
    [
      "subjects at the count limit",
      () => ({
        ...rawEvent(),
        subjects: Array.from({ length: EVENT_LIMITS.subjectCount }, (_, i) => ({
          subject_id: `s${i}`,
          role: "about",
        })),
      }),
      "",
    ],
    [
      "too many attachments",
      () => ({
        ...rawEvent(),
        attachments: Array.from(
          { length: EVENT_LIMITS.attachmentCount + 1 },
          (_, i) => ({ attachment_id: `a${i}`, media_type: "text/plain" }),
        ),
      }),
      "attachments",
    ],
    [
      "display_name one byte over the limit",
      () => ({
        ...rawEvent(),
        subjects: [
          {
            subject_id: "a",
            role: "from",
            display_name: "n".repeat(EVENT_LIMITS.displayNameBytes + 1),
          },
        ],
      }),
      "subjects[0].display_name",
    ],
    [
      "filename one byte over the limit",
      () => ({
        ...rawEvent(),
        attachments: [
          {
            attachment_id: "a",
            media_type: "text/plain",
            filename: "f".repeat(EVENT_LIMITS.filenameBytes + 1),
          },
        ],
      }),
      "attachments[0].filename",
    ],
    [
      "media_type one byte over the limit",
      () => ({
        ...rawEvent(),
        attachments: [
          {
            attachment_id: "a",
            media_type: "m".repeat(EVENT_LIMITS.mediaTypeBytes + 1),
          },
        ],
      }),
      "attachments[0].media_type",
    ],
    [
      "metadata string one byte over the limit",
      () => ({
        ...rawEvent(),
        metadata: { blob: "x".repeat(EVENT_LIMITS.metadataStringBytes + 1) },
      }),
      "metadata.blob",
    ],
    [
      "metadata string at the byte limit",
      () => ({
        ...rawEvent(),
        metadata: { blob: "x".repeat(EVENT_LIMITS.metadataStringBytes) },
      }),
      "",
    ],
    [
      "metadata array one past the length limit",
      () => ({
        ...rawEvent(),
        metadata: { list: Array.from({ length: EVENT_LIMITS.metadataArrayLength + 1 }, () => 1) },
      }),
      "metadata.list",
    ],
    [
      "metadata object one past the key-count limit",
      () => ({
        ...rawEvent(),
        metadata: Object.fromEntries(
          Array.from({ length: EVENT_LIMITS.metadataKeysPerObject + 1 }, (_, i) => [
            `k${i}`,
            1,
          ]),
        ),
      }),
      "metadata",
    ],
    [
      "metadata nested one past the depth limit",
      () => ({ ...rawEvent(), metadata: nest(EVENT_LIMITS.metadataDepth) }),
      "metadata",
    ],
    [
      "metadata nested at the depth limit",
      () => ({ ...rawEvent(), metadata: nest(EVENT_LIMITS.metadataDepth - 1) }),
      "",
    ],
    [
      "occurred_at one byte over the timestamp limit",
      () => ({
        ...rawEvent(),
        occurred_at: `${"2026-01-01T00:00:00."}${"0".repeat(EVENT_LIMITS.timestampBytes)}Z`,
      }),
      "occurred_at",
    ],
  ];

  for (const [name, build, field] of limitCases) {
    test(name, () => {
      const result = validateEventInput(build());
      if (field === "") {
        expect(result.ok).toBe(true);
        return;
      }
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errors.some((error) => error.startsWith(field))).toBe(true);
    });
  }

  test("rejects a metadata cycle", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const result = validateEventInput({ ...rawEvent(), metadata: cycle });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((error) => error.includes("cycle"))).toBe(true);
  });
});

function omit(key: string): Record<string, unknown> {
  const e = rawEvent();
  delete e[key];
  return e;
}

function protoBag(key: string, value: unknown): Record<string, unknown> {
  const bag = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(bag, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return bag;
}

function nest(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    current = { child: current };
  }
  return current;
}
