import { describe, expect, test } from "bun:test";
import { MAX_JSON_DEPTH, MAX_YTD_BYTES, parseYtd } from "../src";

describe("YTD parser", () => {
  test("parses only the exact data assignment as JSON", () => {
    expect(parseYtd('window.YTD.tweets.part0 = [{"tweet":{"id_str":"1"}}];', "tweets", 0))
      .toHaveLength(1);
  });

  test.each([
    'globalThis.pwned=true; window.YTD.tweets.part0 = [];',
    'window.YTD.likes.part0 = [];',
    'window.YTD.tweets.part1 = [];',
    'window.YTD.tweets.part0 = (() => [])();',
    'window.YTD.tweets.part0 = {};',
  ])("refuses executable or mismatched input", (source) => {
    expect(() => parseYtd(source, "tweets", 0)).toThrow();
  });

  test("refuses excessive JSON nesting before parsing", () => {
    const nested = "[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1);
    expect(() => parseYtd(`window.YTD.tweets.part0 = ${nested};`, "tweets", 0))
      .toThrow("exceeds JSON depth");
  });

  test("refuses an oversized direct parser input before JSON.parse", () => {
    const source = `window.YTD.tweets.part0 = ["${"x".repeat(MAX_YTD_BYTES)}"];`;
    expect(() => parseYtd(source, "tweets", 0)).toThrow("exceeds");
  });
});
