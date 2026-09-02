import { expect, test } from "bun:test";
import { KizukiError } from "../src/errors";
import { parseCsv } from "../src/import-pocket/csv";

function thrown(body: () => unknown): KizukiError {
  try {
    body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

test("a quoted field keeps commas, quotes and newlines", () => {
  expect(parseCsv('"Local-first software, explained",b\n', "fixture")).toEqual([
    ["Local-first software, explained", "b"],
  ]);
  expect(parseCsv('"A ""quoted"" title",b\n', "fixture")).toEqual([
    ['A "quoted" title', "b"],
  ]);
  expect(parseCsv('"two\nlines",b\n', "fixture")).toEqual([
    ["two\nlines", "b"],
  ]);
});

test("rows end at a newline however it is written", () => {
  expect(parseCsv("a,b\r\nc,d\r\n", "fixture")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(parseCsv("a,b\nc,d", "fixture")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("blank lines are skipped and a trailing empty field is kept", () => {
  expect(parseCsv("a,b\n\nc,d\n", "fixture")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(parseCsv("a,b,\n", "fixture")).toEqual([["a", "b", ""]]);
  expect(parseCsv('a,"",\n', "fixture")).toEqual([["a", "", ""]]);
});

test("an unterminated quote names its row", () => {
  const error = thrown(() => parseCsv('a,b\nc,"unterminated\n', "part.csv"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("part.csv row 2");
  expect(error.message).toContain("unterminated quote");
});

test("a quote inside an unquoted field is refused", () => {
  const error = thrown(() => parseCsv('a,b"c\n', "part.csv"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("part.csv row 1");
});

test("field and row bounds are enforced", () => {
  const wide = thrown(() =>
    parseCsv("aaaa,b\n", "part.csv", { maxFieldBytes: 2 }),
  );
  expect(wide.code).toBe("parse_error");
  expect(wide.message).toContain("part.csv row 1");

  const tall = thrown(() => parseCsv("a\nb\nc\n", "part.csv", { maxRows: 2 }));
  expect(tall.code).toBe("parse_error");
  expect(tall.message).toContain("more than 2 rows");
});
