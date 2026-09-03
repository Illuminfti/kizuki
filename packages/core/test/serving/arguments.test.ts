import { describe, expect, test } from "bun:test";
import { DEFAULT_GRANT } from "../../src/agents";
import type { Grant } from "../../src/agents";
import {
  day,
  enumOf,
  idList,
  identifier,
  limit,
  relPath,
  rfc3339,
  scopedSubjects,
  scopedTypes,
  scopedWindow,
  text,
} from "../../src/serving/arguments";
import { ServeError } from "../../src/serving/types";

function grantWith(patch: Partial<Grant>): Grant {
  return { ...DEFAULT_GRANT, ...patch };
}

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("bounded argument validators", () => {
  test("identifier accepts the audit short-id shape and refuses the rest", () => {
    expect(identifier("id", "person:ada")).toBe("person:ada");
    expect(identifier("id", "entities/person-ada.md")).toBe(
      "entities/person-ada.md",
    );
    for (const bad of ["", "-leading", "has space", "a".repeat(65), 7]) {
      expect(refusal(() => identifier("id", bad)).code).toBe(
        "invalid_arguments",
      );
    }
  });

  test("text bounds length and refuses control characters", () => {
    expect(text("query", " kettle ", 512)).toBe(" kettle ");
    expect(text("body", "a\tb\nc\r\n", 8)).toBe("a\tb\nc\r\n");
    expect(refusal(() => text("query", "   ", 512)).message).toContain("query");
    expect(refusal(() => text("query", "ab", 1)).code).toBe(
      "invalid_arguments",
    );
    expect(refusal(() => text("query", "a\u0007b", 8)).code).toBe(
      "invalid_arguments",
    );
    expect(refusal(() => text("query", 4, 8)).code).toBe("invalid_arguments");
  });

  test("limit falls back and refuses out-of-range integers", () => {
    expect(limit("limit", undefined, 50, 20)).toBe(20);
    expect(limit("limit", 7, 50, 20)).toBe(7);
    for (const bad of [0, 51, 1.5, "3"]) {
      expect(refusal(() => limit("limit", bad, 50, 20)).code).toBe(
        "invalid_arguments",
      );
    }
  });

  test("idList refuses oversized lists, bad ids and duplicates", () => {
    expect(idList("subjects", ["person:ada", "person:grace"], 16)).toEqual([
      "person:ada",
      "person:grace",
    ]);
    expect(refusal(() => idList("subjects", "person:ada", 16)).code).toBe(
      "invalid_arguments",
    );
    expect(
      refusal(() => idList("subjects", ["person:ada", "person:ada"], 16)).code,
    ).toBe("invalid_arguments");
    expect(refusal(() => idList("subjects", ["a", "b", "c"], 2)).code).toBe(
      "invalid_arguments",
    );
    expect(refusal(() => idList("subjects", ["bad id"], 16)).code).toBe(
      "invalid_arguments",
    );
  });

  test("rfc3339 and day check real calendar values", () => {
    expect(rfc3339("since", "2026-02-28T10:30:00Z")).toBe(
      "2026-02-28T10:30:00Z",
    );
    expect(refusal(() => rfc3339("since", "2026-02-30T10:30:00Z")).code).toBe(
      "invalid_arguments",
    );
    expect(day("day", "2026-02-28")).toBe("2026-02-28");
    expect(refusal(() => day("day", "2026-2-8")).code).toBe(
      "invalid_arguments",
    );
  });

  test("relPath refuses traversal, absolute paths and backslashes", () => {
    expect(relPath("path", "entities/person-ada.md")).toBe(
      "entities/person-ada.md",
    );
    for (const bad of [
      "../x.md",
      "/abs.md",
      "a\\b.md",
      "./x.md",
      "notes.txt",
      `${"a".repeat(257)}.md`,
      ".md",
    ]) {
      expect(refusal(() => relPath("path", bad)).code).toBe(
        "invalid_arguments",
      );
    }
  });

  test("enumOf pins a closed set", () => {
    expect(enumOf("scope", "ledger", ["canon", "ledger", "all"] as const)).toBe(
      "ledger",
    );
    expect(
      refusal(() => enumOf("scope", "vault", ["canon", "ledger"] as const))
        .code,
    ).toBe("invalid_arguments");
  });
});

describe("grant scope intersection", () => {
  test("an unscoped grant passes the request through", () => {
    const grant = grantWith({ subjects: null, types: null });
    expect(scopedSubjects(grant, ["person:ada"])).toEqual(["person:ada"]);
    expect(scopedSubjects(grant, undefined)).toBeUndefined();
    expect(scopedTypes(grant, undefined)).toBeUndefined();
  });

  test("a scoped grant narrows an absent request and refuses a foreign one", () => {
    const grant = grantWith({
      subjects: ["person:ada"],
      types: ["person"],
    });
    expect(scopedSubjects(grant, undefined)).toEqual(["person:ada"]);
    expect(scopedSubjects(grant, ["person:ada"])).toEqual(["person:ada"]);
    expect(refusal(() => scopedSubjects(grant, ["person:grace"])).code).toBe(
      "subject_out_of_scope",
    );
    expect(scopedTypes(grant, undefined)).toEqual(["person"]);
    expect(refusal(() => scopedTypes(grant, ["fact"])).code).toBe(
      "type_out_of_scope",
    );
  });

  test("the window is the intersection of grant and request", () => {
    const grant = grantWith({
      since: "2026-01-01T00:00:00Z",
      until: "2026-03-01T00:00:00Z",
    });
    expect(
      scopedWindow(grant, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z"),
    ).toEqual({ since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z" });
    expect(scopedWindow(grant, undefined, undefined)).toEqual({
      since: "2026-01-01T00:00:00Z",
      until: "2026-03-01T00:00:00Z",
    });
    expect(
      scopedWindow(
        grantWith({ since: null, until: null }),
        undefined,
        undefined,
      ),
    ).toEqual({});
  });
});
