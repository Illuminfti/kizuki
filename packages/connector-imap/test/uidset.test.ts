import { describe, expect, test } from "bun:test";
import {
  addUid,
  chunk,
  countUids,
  formatSet,
  hasUid,
  parseSet,
  removeUid,
  uids,
} from "../src/uidset";

describe("sequence sets", () => {
  test("parses ranges and single uids", () => {
    expect(parseSet("1:3,5")).toEqual([
      { first: 1, last: 3 },
      { first: 5, last: 5 },
    ]);
    expect(parseSet("")).toEqual([]);
    expect(parseSet("7")).toEqual([{ first: 7, last: 7 }]);
  });

  test("normalises reversed, overlapping and unsorted input", () => {
    expect(parseSet("9:7,1,2")).toEqual([
      { first: 1, last: 2 },
      { first: 7, last: 9 },
    ]);
    expect(parseSet("1:5,3:8")).toEqual([{ first: 1, last: 8 }]);
  });

  test("refuses malformed input", () => {
    for (const bad of ["1:", ":2", "a", "1,,2", "0", "1:2:3", "-1", "1.5"]) {
      expect(() => parseSet(bad)).toThrow();
    }
  });

  test("formats back to wire form", () => {
    expect(formatSet(parseSet("1:3,5"))).toBe("1:3,5");
    expect(formatSet([])).toBe("");
    expect(formatSet(parseSet("4"))).toBe("4");
  });

  test("adding merges adjacent ranges", () => {
    expect(formatSet(addUid(parseSet("1:3,5"), 4))).toBe("1:5");
    expect(formatSet(addUid(parseSet("1:3"), 3))).toBe("1:3");
    expect(formatSet(addUid([], 10))).toBe("10");
    expect(formatSet(addUid(parseSet("1:3"), 9))).toBe("1:3,9");
  });

  test("removing splits a range", () => {
    expect(formatSet(removeUid(parseSet("1:5"), 3))).toBe("1:2,4:5");
    expect(formatSet(removeUid(parseSet("1:5"), 1))).toBe("2:5");
    expect(formatSet(removeUid(parseSet("1:5"), 5))).toBe("1:4");
    expect(formatSet(removeUid(parseSet("4"), 4))).toBe("");
    expect(formatSet(removeUid(parseSet("1:3"), 9))).toBe("1:3");
  });

  test("iterates and counts", () => {
    expect([...uids(parseSet("1:3,5"))]).toEqual([1, 2, 3, 5]);
    expect(countUids(parseSet("1:3,5"))).toBe(4);
    expect(hasUid(parseSet("1:3,5"), 2)).toBe(true);
    expect(hasUid(parseSet("1:3,5"), 4)).toBe(false);
  });

  test("chunks a set into wire-form pieces of a bounded size", () => {
    expect([...chunk(parseSet("1:5,9"), 2)]).toEqual(["1:2", "3:4", "5,9"]);
    expect([...chunk(parseSet("1:4"), 10)]).toEqual(["1:4"]);
    expect([...chunk([], 10)]).toEqual([]);
  });

  test("produces only the pieces a caller asks for", () => {
    // A million known UIDs must not become a million strings before the
    // caller has looked at the first one.
    const pieces = chunk(parseSet("1:1000000"), 500);
    expect(pieces.next().value).toBe("1:500");
    expect(pieces.next().value).toBe("501:1000");
    pieces.return(undefined);
  });
});
