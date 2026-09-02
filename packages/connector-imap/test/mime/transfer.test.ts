import { describe, expect, test } from "bun:test";
import { decodeEncodedWords } from "../../src/mime/rfc2047";
import {
  decodeBase64Text,
  decodeQuotedPrintableText,
  decodeTransfer,
} from "../../src/mime/transfer";
import { decodeCharset } from "../../src/mime/charset";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf8 = (bytes: Uint8Array | null): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

describe("transfer encodings", () => {
  test("decodes base64 with padding and embedded newlines", () => {
    expect(utf8(decodeBase64Text("aGVsbG8="))).toBe("hello");
    expect(utf8(decodeBase64Text("aGVs\r\nbG8="))).toBe("hello");
    expect(utf8(decodeBase64Text("8J+Ygg=="))).toBe("\u{1F602}");
    expect(decodeBase64Text("not base64!")).toBeNull();
  });

  test("decodes quoted-printable escapes, soft breaks and trailing space", () => {
    expect(utf8(decodeQuotedPrintableText("caf=C3=A9"))).toBe("café");
    expect(utf8(decodeQuotedPrintableText("one=\r\ntwo"))).toBe("onetwo");
    expect(utf8(decodeQuotedPrintableText("a  \r\nb"))).toBe("a\r\nb");
    expect(utf8(decodeQuotedPrintableText("50=25 off"))).toBe("50% off");
    expect(utf8(decodeQuotedPrintableText("bad=ZZ"))).toBe("bad=ZZ");
  });

  test("routes by encoding name and passes identity encodings through", () => {
    expect(utf8(decodeTransfer("BASE64", encode("aGk=")).bytes)).toBe("hi");
    expect(utf8(decodeTransfer("Quoted-Printable", encode("=41")).bytes)).toBe(
      "A",
    );
    expect(utf8(decodeTransfer("8bit", encode("plain")).bytes)).toBe("plain");
    expect(utf8(decodeTransfer(undefined, encode("plain")).bytes)).toBe(
      "plain",
    );
    expect(decodeTransfer("BASE64", encode("aGk=")).fallback).toBeUndefined();
  });

  test("a stray character in a base64 body keeps the text and says so", () => {
    const decoded = decodeTransfer(
      "base64",
      encode("UXVhcnRlcmx5IG51bWJlcnM=\r\n*\r\n"),
    );
    expect(utf8(decoded.bytes)).toBe("Quarterly numbers");
    expect(decoded.fallback).toBe("base64");
  });

  test("a body that is not base64 at all keeps its raw bytes", () => {
    const decoded = decodeTransfer("base64", encode("!!! ??? ***"));
    expect(utf8(decoded.bytes)).toBe("!!! ??? ***");
    expect(decoded.fallback).toBe("base64");
  });

  test("a malformed quoted-printable body keeps its raw bytes", () => {
    const decoded = decodeTransfer("quoted-printable", encode("Hello =ZZ"));
    expect(utf8(decoded.bytes)).toBe("Hello =ZZ");
  });
});

describe("charset decoding", () => {
  test("falls back to windows-1252 for a label this platform lacks", () => {
    const decoded = decodeCharset(Uint8Array.from([0xe9]), "iso-8859-2");
    expect(decoded.fallback).toBe("iso-8859-2");
    expect(decoded.text).toBe("é");
  });

  test("uses the declared label when it is supported", () => {
    expect(decodeCharset(Uint8Array.from([0xe9]), "windows-1252").text).toBe("é");
    expect(decodeCharset(encode("hi"), "").text).toBe("hi");
  });
});

describe("RFC 2047 encoded words", () => {
  test("decodes B and Q words", () => {
    expect(decodeEncodedWords("=?utf-8?B?aGVsbG8=?=").text).toBe("hello");
    expect(decodeEncodedWords("=?utf-8?Q?caf=C3=A9?=").text).toBe("café");
    expect(decodeEncodedWords("=?utf-8?Q?two_words?=").text).toBe("two words");
  });

  test("merges adjacent words and keeps surrounding text", () => {
    expect(
      decodeEncodedWords("Re: =?utf-8?Q?caf?= =?utf-8?Q?=C3=A9?= today").text,
    ).toBe("Re: café today");
    expect(decodeEncodedWords("=?iso-8859-1?Q?a?=b").text).toBe("ab");
  });

  test("mixes two charsets in one field", () => {
    const decoded = decodeEncodedWords(
      "=?windows-1252?Q?caf=E9?= and =?utf-8?B?8J+Ygg==?=",
    );
    expect(decoded.text).toBe("café and \u{1F602}");
  });

  test("records an unusable charset and leaves a malformed word verbatim", () => {
    const decoded = decodeEncodedWords("=?koi8-r?Q?x?=");
    expect(decoded.fallbacks).toEqual(["koi8-r"]);
    expect(decodeEncodedWords("=?utf-8?X?zz?=").text).toBe("=?utf-8?X?zz?=");
    expect(decodeEncodedWords("=?utf-8?B?%%%?=").text).toBe("=?utf-8?B?%%%?=");
  });
});
