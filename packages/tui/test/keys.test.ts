import { describe, expect, test } from "bun:test";
import { parseKeys } from "../src/keys";

describe("parseKeys", () => {
  test("maps single bytes to named keys", () => {
    expect(parseKeys("\r")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\n")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\x7f")).toEqual([{ name: "backspace" }]);
    expect(parseKeys("\t")).toEqual([{ name: "tab" }]);
    expect(parseKeys("\x03")).toEqual([{ name: "ctrl-c" }]);
    expect(parseKeys("\x1b")).toEqual([{ name: "escape" }]);
  });

  test("decodes arrow and page sequences in both CSI and SS3 forms", () => {
    expect(parseKeys("\x1b[A")).toEqual([{ name: "up" }]);
    expect(parseKeys("\x1bOB")).toEqual([{ name: "down" }]);
    expect(parseKeys("\x1b[5~")).toEqual([{ name: "pageup" }]);
    expect(parseKeys("\x1b[6~")).toEqual([{ name: "pagedown" }]);
    expect(parseKeys("\x1b[H")).toEqual([{ name: "home" }]);
    expect(parseKeys("\x1b[F")).toEqual([{ name: "end" }]);
  });

  test("splits a chunk with several keys and keeps unicode characters whole", () => {
    expect(parseKeys("jk")).toEqual([
      { name: "char", ch: "j" },
      { name: "char", ch: "k" },
    ]);
    expect(parseKeys(new TextEncoder().encode("気\x1b[Bé"))).toEqual([
      { name: "char", ch: "気" },
      { name: "down" },
      { name: "char", ch: "é" },
    ]);
  });

  test("swallows an unknown CSI sequence instead of leaking it as text", () => {
    expect(parseKeys("\x1b[<35;10;20Mx")).toEqual([
      { name: "unknown" },
      { name: "char", ch: "x" },
    ]);
  });
});
