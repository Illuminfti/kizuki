import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GRANT,
  OWNER,
  authorize,
  filterServable,
  toolAllowed,
} from "../../src/agents";
import type { Grant, Servable } from "../../src/agents";

function grant(overrides: Partial<Grant> = {}): Grant {
  return { ...DEFAULT_GRANT, tools: [...DEFAULT_GRANT.tools], ...overrides };
}

function item(overrides: Partial<Servable> = {}): Servable {
  return {
    id: "page-1",
    sensitivity: "personal",
    type: "person",
    subjects: ["person:ada"],
    occurred_at: "2026-06-01T12:00:00Z",
    ...overrides,
  };
}

describe("authorize", () => {
  test("allows an item inside every grant dimension", () => {
    expect(
      authorize(
        grant({
          types: ["person"],
          subjects: ["person:ada"],
          since: "2026-06-01T11:00:00Z",
          until: "2026-06-01T13:00:00Z",
        }),
        item(),
      ),
    ).toEqual({ allow: true });
  });

  test("checks held before every other policy", () => {
    expect(
      authorize(
        grant({ ceiling: "public", types: [], subjects: [], since: "2027-01-01T00:00:00Z" }),
        item({ held: true, sensitivity: null }),
      ),
    ).toEqual({ allow: false, reason: "held" });
  });

  const missingLabels: (string | null | undefined)[] = [
    null,
    undefined,
    "unlabeled",
    "secret",
  ];
  for (const label of missingLabels) {
    test(`denies missing or unknown sensitivity ${String(label)}`, () => {
      expect(authorize(grant({ ceiling: "private" }), item({ sensitivity: label }))).toEqual({
        allow: false,
        reason: "missing_sensitivity",
      });
    });
  }

  test("reports missing sensitivity before above-ceiling scope", () => {
    expect(
      authorize(grant({ ceiling: "public" }), item({ sensitivity: "unlabeled" })),
    ).toEqual({ allow: false, reason: "missing_sensitivity" });
  });

  test("denies a label above the grant ceiling", () => {
    expect(authorize(grant(), item({ sensitivity: "private" }))).toEqual({
      allow: false,
      reason: "above_ceiling",
    });
  });

  test("denies a missing or excluded type when types are restricted", () => {
    const restricted = grant({ types: ["fact"] });
    const missingType = item();
    delete missingType.type;
    expect(authorize(restricted, item())).toEqual({
      allow: false,
      reason: "type_out_of_scope",
    });
    expect(authorize(restricted, missingType)).toEqual({
      allow: false,
      reason: "type_out_of_scope",
    });
  });

  test("checks type before subject and time", () => {
    expect(
      authorize(
        grant({
          types: ["fact"],
          subjects: ["person:grace"],
          since: "2027-01-01T00:00:00Z",
        }),
        item(),
      ),
    ).toEqual({ allow: false, reason: "type_out_of_scope" });
  });

  test("allows any matching subject in a restricted grant", () => {
    expect(
      authorize(
        grant({ subjects: ["person:grace"] }),
        item({ subjects: ["person:ada", "person:grace"] }),
      ),
    ).toEqual({ allow: true });
  });

  test("denies absent and nonmatching subjects under a restriction", () => {
    const restricted = grant({ subjects: ["person:grace"] });
    const missingSubjects = item();
    delete missingSubjects.subjects;
    for (const candidate of [missingSubjects, item({ subjects: [] }), item({ subjects: ["person:ada"] })]) {
      expect(authorize(restricted, candidate)).toEqual({
        allow: false,
        reason: "subject_out_of_scope",
      });
    }
  });

  test("checks subject before time", () => {
    expect(
      authorize(
        grant({ subjects: ["person:grace"], since: "2027-01-01T00:00:00Z" }),
        item(),
      ),
    ).toEqual({ allow: false, reason: "subject_out_of_scope" });
  });

  test("treats time bounds as inclusive instants across offsets", () => {
    const restricted = grant({
      since: "2026-06-01T13:00:00+01:00",
      until: "2026-06-01T08:00:00-04:00",
    });
    expect(authorize(restricted, item())).toEqual({ allow: true });
  });

  const outOfTime: [string, string][] = [
    ["malformed", "not-a-time"],
    ["before", "2026-05-31T23:59:59Z"],
    ["after", "2026-06-02T00:00:01Z"],
  ];
  for (const [name, occurred_at] of outOfTime) {
    test(`denies ${name} time under bounded access`, () => {
      expect(
        authorize(
          grant({
            since: "2026-06-01T00:00:00Z",
            until: "2026-06-02T00:00:00Z",
          }),
          item({ occurred_at }),
        ),
      ).toEqual({ allow: false, reason: "time_out_of_scope" });
    });
  }

  test("denies missing time under bounded access", () => {
    const missingTime = item();
    delete missingTime.occurred_at;
    expect(
      authorize(
        grant({
          since: "2026-06-01T00:00:00Z",
          until: "2026-06-02T00:00:00Z",
        }),
        missingTime,
      ),
    ).toEqual({ allow: false, reason: "time_out_of_scope" });
  });
});

describe("grant-ceiling exit proof", () => {
  test("denies private to personal and allows it to private", () => {
    const privateItem = item({ sensitivity: "private" });
    expect(authorize(grant({ ceiling: "personal" }), privateItem)).toEqual({
      allow: false,
      reason: "above_ceiling",
    });
    expect(authorize(grant({ ceiling: "private" }), privateItem)).toEqual({
      allow: true,
    });
  });

  test("denies unlabeled items to every grant including the owner", () => {
    for (const ceiling of ["public", "personal", "private"] as const) {
      expect(authorize(grant({ ceiling }), item({ sensitivity: null }))).toEqual({
        allow: false,
        reason: "missing_sensitivity",
      });
    }
    expect(authorize(OWNER.grant, item({ sensitivity: undefined }))).toEqual({
      allow: false,
      reason: "missing_sensitivity",
    });
  });
});

describe("serving helpers", () => {
  test("partitions served items and compact denials in input order", () => {
    const allowed = item({ id: "allowed", sensitivity: "public" });
    const privateItem = item({ id: "private", sensitivity: "private" });
    const unlabeled = item({ id: "unlabeled", sensitivity: null });

    expect(filterServable(grant(), [allowed, privateItem, unlabeled])).toEqual({
      served: [allowed],
      denied: [
        { id: "private", reason: "above_ceiling" },
        { id: "unlabeled", reason: "missing_sensitivity" },
      ],
    });
  });

  test("checks the tool allowlist exactly", () => {
    const restricted = grant({ tools: ["search", "timeline"] });
    expect(toolAllowed(restricted, "search")).toBe(true);
    expect(toolAllowed(restricted, "get_page")).toBe(false);
  });
});
