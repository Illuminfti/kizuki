import { describe, expect, test } from "bun:test";
import { OWNER, filterServable } from "../src";

describe("RFC 0002 autonomous canon contract", () => {
  test.todo(
    "canon-writer lane: autonomous canon write succeeds through the receipted writer",
  );

  test.todo(
    "correction and undo-audit lanes: correction supersession is reversible from its receipt",
  );

  test("unlabeled sensitivity is not served, including to the owner", () => {
    const item = { id: "fact:unlabeled", sensitivity: undefined };

    expect(filterServable(OWNER.grant, [item])).toEqual({
      served: [],
      denied: [{ id: item.id, reason: "missing_sensitivity" }],
    });
  });

  test.todo(
    "canon-writer lane: source scanning confines canon mutation to the receipted capability",
  );
});
