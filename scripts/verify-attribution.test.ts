import { describe, expect, test } from "bun:test";
import { validateAttributionText } from "./verify-attribution";

const exactCredit = "AtlasCore";
const canonicalUrl = "https://example.invalid/AtlasCore";
const path = "docs/credit.md";

function failures(text: string) {
  return validateAttributionText(path, text, exactCredit, canonicalUrl);
}

describe("attribution verification", () => {
  test("requires an exact credit and canonical URL in each document", () => {
    expect(failures(canonicalUrl)).toEqual([
      expect.objectContaining({ reason: "public attribution is missing the exact credit" }),
    ]);
    expect(failures(exactCredit)).toEqual([
      expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
    ]);
  });

  test("accepts an exact credit with punctuation, possessives, and code spans", () => {
    expect(
      failures(`\`${exactCredit}\`, ${exactCredit}'s guide: [${exactCredit}](${canonicalUrl})`),
    ).toEqual([]);
    expect(failures(`\`${exactCredit} ${canonicalUrl}\``)).toEqual([]);
  });

  test("keeps original offsets after unrelated Unicode prose", () => {
    expect(failures(`İ [${exactCredit}](${canonicalUrl})`)).toEqual([]);
  });

  test("reports original line and UTF-16 column for every invalid credit", () => {
    const text = `atlascore\r\n\r\n😀 atlascore\n[${exactCredit}](${canonicalUrl})\natlascore`;
    expect(failures(text)).toEqual([
      expect.objectContaining({ path, line: 1, column: 1 }),
      expect.objectContaining({ path, line: 3, column: 4 }),
      expect.objectContaining({ path, line: 5, column: 1 }),
    ]);
  });

  test("locates invalid credit after a long multiline prefix", () => {
    const prefix = "unrelated prose\n".repeat(100_000);
    expect(failures(`${prefix}atlascore\n[${exactCredit}](${canonicalUrl})`)).toEqual([
      expect.objectContaining({ path, line: 100_001, column: 1 }),
    ]);
  });

  test("locates dense diagnostics across valid credits and repeated calls", () => {
    const row = `atlascore ${exactCredit} atlascore\r\n`;
    const text = row.repeat(2_000) + `[${exactCredit}](${canonicalUrl})`;
    const expected = Array.from({ length: 2_000 }, (_, index) => [
      expect.objectContaining({ path, line: index + 1, column: 1 }),
      expect.objectContaining({ path, line: index + 1, column: 21 }),
    ]).flat();
    expect(failures(text)).toEqual(expected);
    expect(failures(`atlascore [${exactCredit}](${canonicalUrl})`)).toEqual([
      expect.objectContaining({ path, line: 1, column: 1 }),
    ]);
  });

  test("treats the configured credit as literal text", () => {
    const punctuatedCredit = "Atlas.Core+";
    const punctuatedUrl = "https://example.invalid/Atlas.Core+";
    expect(
      validateAttributionText(
        path,
        `[${punctuatedCredit}](${punctuatedUrl})`,
        punctuatedCredit,
        punctuatedUrl,
      ),
    ).toEqual([]);
  });

  test.each([
    `prefix${exactCredit}`,
    `${exactCredit}Suffix`,
    `é${exactCredit}`,
    `${exactCredit}\u0301`,
    `${exactCredit}\u203FSuffix`,
    `${exactCredit}\u200DSuffix`,
    `${exactCredit}\u00B7Suffix`,
    `${exactCredit}\u0387Suffix`,
    `${exactCredit}\u30FBSuffix`,
  ])("rejects an embedded credit in %p", (embeddedCredit) => {
    expect(failures(`[${exactCredit}](${canonicalUrl}) ${embeddedCredit}`)).toEqual([
      expect.objectContaining({ reason: "public attribution does not use the exact spelling" }),
    ]);
  });

  test.each(["‿", "‍", "😀", "𐐀", "\u00a0", "\u2003", "\u202f"])(
    "rejects a canonical URL with a Unicode neighbour %p",
    (neighbour) => {
      for (const url of [`${neighbour}${canonicalUrl}`, `${canonicalUrl}${neighbour}`]) {
        expect(failures(`[${exactCredit}](${url})`)).toEqual([
          expect.objectContaining({
            reason: "public attribution URL is not the exact delimited canonical URL",
          }),
          expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
        ]);
      }
    },
  );

  test.each(["|", "{", "}", "[", "]"])(
    "rejects a modified Markdown link destination containing %p",
    (neighbour) => {
      for (const url of [`${neighbour}${canonicalUrl}`, `${canonicalUrl}${neighbour}suffix`]) {
        expect(failures(`[${exactCredit}](${url})`)).toEqual([
          expect.objectContaining({
            reason: "public attribution URL is not the exact delimited canonical URL",
          }),
          expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
        ]);
      }
    },
  );

  test("accepts canonical URLs in autolinks and spaced table cells", () => {
    expect(failures(`[${exactCredit}](<${canonicalUrl}>)`)).toEqual([]);
    expect(failures(`| ${exactCredit} | ${canonicalUrl} |`)).toEqual([]);
  });

  test("does not let a valid link mask a suffixed destination", () => {
    expect(failures(`[${exactCredit}](${canonicalUrl}) [reference](${canonicalUrl}|suffix)`)).toEqual([
      expect.objectContaining({
        reason: "public attribution URL is not the exact delimited canonical URL",
      }),
    ]);
  });

  test("rejects a case-modified URL as a URL, not prose", () => {
    expect(failures(`[${exactCredit}](HTTPS://example.invalid/AtlasCore)`)).toEqual([
      expect.objectContaining({
        reason: "public attribution URL is not the exact delimited canonical URL",
      }),
      expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
    ]);
  });
});
