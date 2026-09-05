import { describe, expect, test } from "bun:test";
import { canonicalSerialize, computeContentHash, computeLegacyContentHash } from "../src/util/hash";
import type { CaptureEventInput } from "../src/contracts/event";
import { validEvent } from "./fixtures";

describe("canonicalSerialize", () => {
  test("covers exactly the ten version-2 identity fields", () => {
    const parsed = JSON.parse(canonicalSerialize(validEvent())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed)).toEqual([
      "attachments",
      "connector_id",
      "deleted",
      "kind",
      "metadata",
      "occurred_at",
      "sensitivity_hint",
      "source_record_id",
      "subjects",
      "text",
    ]);
  });

  test("sorts nested object keys at every depth", () => {
    const event = validEvent();
    event.metadata = { z: { b: 1, a: { d: 4, c: 3 } }, y: 2 };
    expect(canonicalSerialize(event)).toContain(
      '"metadata":{"y":2,"z":{"a":{"c":3,"d":4},"b":1}}',
    );
  });

  test("preserves array order", () => {
    const event = validEvent();
    event.metadata = { list: [3, 1, 2] };
    expect(canonicalSerialize(event)).toContain('"list":[3,1,2]');
  });

  test("keeps __proto__ as a data key instead of polluting the accumulator", () => {
    const event = validEvent();
    event.metadata = protoBag("__proto__", { x: 1 });
    const serialized = canonicalSerialize(event);
    expect(serialized).toContain('"__proto__":{"x":1}');
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "x"),
    ).toBe(false);
    const empty = validEvent();
    empty.metadata = {};
    expect(computeContentHash(event)).not.toBe(computeContentHash(empty));
  });

  test("keeps constructor and prototype as data keys", () => {
    const event = validEvent();
    event.metadata = protoBag("constructor", { y: 2 });
    Object.defineProperty(event.metadata, "prototype", {
      value: { z: 3 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const serialized = canonicalSerialize(event);
    expect(serialized).toContain('"constructor":{"y":2}');
    expect(serialized).toContain('"prototype":{"z":3}');
  });
});

describe("computeContentHash", () => {
  test("returns 64 lowercase hex characters", () => {
    expect(computeContentHash(validEvent())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across repeated calls", () => {
    expect(computeContentHash(validEvent())).toBe(
      computeContentHash(validEvent()),
    );
  });

  test("ignores top-level key insertion order", () => {
    const forward = validEvent();
    const reversed = Object.fromEntries(
      Object.entries(forward).reverse(),
    ) as unknown as CaptureEventInput;
    expect(Object.keys(reversed)).not.toEqual(Object.keys(forward));
    expect(computeContentHash(reversed)).toBe(computeContentHash(forward));
  });

  test("ignores metadata key insertion order", () => {
    const a = validEvent();
    a.metadata = { alpha: 1, beta: { x: 1, y: 2 } };
    const b = validEvent();
    b.metadata = { beta: { y: 2, x: 1 }, alpha: 1 };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  test("ignores subject key insertion order", () => {
    const a = validEvent();
    a.subjects = [
      { subject_id: "person:ada", role: "from", display_name: "Ada" },
    ];
    const b = validEvent();
    b.subjects = [
      { display_name: "Ada", role: "from", subject_id: "person:ada" },
    ];
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  const changed: [string, (e: CaptureEventInput) => void][] = [
    [
      "an edited text body",
      (e) => {
        e.text = `${e.text}!`;
      },
    ],
    [
      "a whitespace-only text edit",
      (e) => {
        e.text = ` ${e.text}`;
      },
    ],
    [
      "a changed metadata value",
      (e) => {
        e.metadata = { ...e.metadata, unread: false };
      },
    ],
    [
      "an added metadata key",
      (e) => {
        e.metadata = { ...e.metadata, pinned: true };
      },
    ],
    [
      "a removed metadata key",
      (e) => {
        e.metadata = {};
      },
    ],
    [
      "a nested metadata change",
      (e) => {
        e.metadata = { thread: { id: "t-9" } };
      },
    ],
    [
      "a changed connector_id",
      (e) => {
        e.connector_id = "other";
      },
    ],
    [
      "a changed source_record_id",
      (e) => {
        e.source_record_id = "rec-2";
      },
    ],
    [
      "a changed kind",
      (e) => {
        e.kind = "email";
      },
    ],
    [
      "a changed occurred_at",
      (e) => {
        e.occurred_at = "2026-02-28T10:30:01Z";
      },
    ],
    [
      "a flipped tombstone",
      (e) => {
        e.deleted = true;
      },
    ],
    [
      "a changed subject role",
      (e) => {
        e.subjects = [{ subject_id: "person:ada", role: "to" }];
      },
    ],
    [
      "reordered subjects",
      (e) => {
        e.subjects = [
          { subject_id: "b", role: "to" },
          { subject_id: "a", role: "from" },
        ];
      },
    ],
  ];

  const baseline = computeContentHash(validEvent());
  for (const [name, mutate] of changed) {
    test(`changes on ${name}`, () => {
      const event = validEvent();
      mutate(event);
      expect(computeContentHash(event)).not.toBe(baseline);
    });
  }

  const revised: [string, (e: CaptureEventInput) => void][] = [
    [
      "a revised sensitivity_hint",
      (e) => {
        e.sensitivity_hint = "private";
      },
    ],
    [
      "a dropped sensitivity_hint",
      (e) => {
        delete e.sensitivity_hint;
      },
    ],
    [
      "removed attachments",
      (e) => {
        e.attachments = [];
      },
    ],
  ];

  for (const [name, mutate] of revised) {
    test(`changes on ${name}, preserving legacy compatibility`, () => {
      const event = validEvent();
      mutate(event);
      expect(computeContentHash(event)).not.toBe(baseline);
      expect(computeLegacyContentHash(event)).toBe(computeLegacyContentHash(validEvent()));
    });
  }

  test("preserves the fixed historical v1 vector and ignores re-observation", () => {
    expect(computeLegacyContentHash(validEvent())).toBe("7c2763905c19903867d9fe751a6c7f7b92f2543a6107704523f54e96630b328c");
    expect(computeContentHash({ ...validEvent(), observed_at: "2030-01-01T00:00:00Z" })).toBe(baseline);
  });

  test("two subject orderings hash differently but each is self-stable", () => {
    const one = validEvent();
    one.subjects = [
      { subject_id: "a", role: "from" },
      { subject_id: "b", role: "to" },
    ];
    const two = validEvent();
    two.subjects = [
      { subject_id: "b", role: "to" },
      { subject_id: "a", role: "from" },
    ];
    expect(computeContentHash(one)).not.toBe(computeContentHash(two));
    expect(computeContentHash(one)).toBe(
      computeContentHash(structuredClone(one)),
    );
  });
});

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
