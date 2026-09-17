import { describe, expect, test } from "bun:test";
import { validateAttributionText } from "./verify-attribution";

const exactCredit = "AtlasCore";
const canonicalUrl = "https://example.invalid/AtlasCore";
const path = "docs/credit.md";

function failures(text: string) {
  return validateAttributionText(path, text, exactCredit, canonicalUrl);
}

describe("attribution verification", () => {
  test.each(["", " ", "\t", "\r\n", "\u00a0"])(
    "rejects a blank configured credit %p before scanning a document",
    (credit) => {
      for (const text of ["", `[${exactCredit}](${canonicalUrl})`]) {
        expect(() => validateAttributionText(path, text, credit, canonicalUrl)).toThrow(
          "attribution identifier must not be empty",
        );
      }
    },
  );

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

  test.each(["‿", "‍", "😀", "𐐀"])(
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

  test("rejects a case-modified URL as a URL, not prose", () => {
    expect(failures(`[${exactCredit}](HTTPS://example.invalid/AtlasCore)`)).toEqual([
      expect.objectContaining({
        reason: "public attribution URL is not the exact delimited canonical URL",
      }),
      expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
    ]);
  });

  test("rejects a suffixed canonical URL that shares the credit's tail", () => {
    expect(failures(`[${exactCredit}](${canonicalUrl}-mirror)`)).toEqual([
      expect.objectContaining({
        reason: "public attribution URL is not the exact delimited canonical URL",
      }),
      expect.objectContaining({ reason: "public attribution is missing the canonical URL" }),
    ]);
  });
});
