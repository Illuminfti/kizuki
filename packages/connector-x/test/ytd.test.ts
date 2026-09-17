import { describe, expect, test } from "bun:test";
import { MAX_JSON_DEPTH, MAX_YTD_BYTES, parseYtd } from "../src";

describe("YTD parser", () => {
  test("parses only the exact data assignment as JSON", () => {
    expect(parseYtd('window.YTD.tweets.part0 = [{"tweet":{"id_str":"1"}}];', "tweets", 0))
      .toHaveLength(1);
    expect(parseYtd('\uFEFFwindow.YTD.tweets.part0 = [{"tweet":{"id_str":"1"}}];', "tweets", 0))
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

  test("requires canonical, safely representable part identifiers", () => {
    for (const dataset of ["account", "tweets"] as const) {
      for (const part of [0, 1, Number.MAX_SAFE_INTEGER]) {
        expect(parseYtd(`window.YTD.${dataset}.part${part} = [];`, dataset, part)).toEqual([]);
        expect(() => parseYtd(`window.YTD.${dataset}.part0${part} = [];`, dataset, part))
          .toThrow("invalid archive wrapper");
      }
      for (const part of ["9007199254740992", "9007199254740993"]) {
        expect(() => parseYtd(`window.YTD.${dataset}.part${part} = [];`, dataset, Number(part)))
          .toThrow("invalid archive wrapper");
      }
    }
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
