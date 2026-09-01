import { describe, expect, test } from "bun:test";
import {
  colorsEnabled,
  padEnd,
  paint,
  sanitize,
  stringWidth,
  stripAnsi,
  truncate,
  wrap,
} from "../src/ansi";

describe("width", () => {
  test("wide characters count as two cells", () => {
    expect(stringWidth("気づき")).toBe(6);
    expect(stringWidth("abc")).toBe(3);
  });

  test("combining marks and escape sequences are zero width", () => {
    expect(stringWidth("é")).toBe(1);
    expect(stringWidth("\x1b[1mbold\x1b[0m")).toBe(4);
  });
});

describe("truncate", () => {
  test("leaves short text alone and cuts long text with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a much longer line", 8)).toBe("a much …");
    expect(stringWidth(truncate("気づきのしゅんかん", 7))).toBeLessThanOrEqual(
      7,
    );
  });

  test("zero width yields nothing", () => {
    expect(truncate("text", 0)).toBe("");
  });
});

describe("padEnd", () => {
  test("pads by cells, not code units, and keeps styling", () => {
    expect(padEnd("気", 4)).toBe("気  ");
    const styled = "\x1b[1mhi\x1b[0m";
    expect(padEnd(styled, 4)).toBe(`${styled}  `);
  });
});

describe("wrap", () => {
  test("wraps on words and keeps blank lines", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  test("hard-breaks a token wider than the column", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("気づきのしゅんかん", 6)).toEqual([
      "気づき",
      "のしゅ",
      "んかん",
    ]);
  });
});

describe("sanitize", () => {
  test("strips escape sequences and control characters, keeps newlines", () => {
    expect(sanitize("plain\x1b[31mred\x1b[0m\n\x07bell")).toBe(
      "plainred\nbell",
    );
    expect(sanitize("a\tb")).toBe("a  b");
    expect(sanitize("\x9bCSI")).toBe("CSI");
  });
});

describe("colors", () => {
  test("respect NO_COLOR, dumb terminals and pipes", () => {
    expect(colorsEnabled({}, true)).toBe(true);
    expect(colorsEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorsEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(colorsEnabled({}, false)).toBe(false);
  });

  test("disabled paint is the identity", () => {
    const off = paint(false);
    expect(off.bold("x")).toBe("x");
    expect(off.fg(12, "x")).toBe("x");
    const on = paint(true);
    expect(stripAnsi(on.fgBold(12, "x"))).toBe("x");
    expect(on.inverse("x")).toContain("\x1b[7m");
  });
});
