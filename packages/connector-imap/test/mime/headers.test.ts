import { describe, expect, test } from "bun:test";
import {
  MAX_HEADER_FIELDS,
  headerValue,
  headerValues,
  parseHeaders,
} from "../../src/mime/headers";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("header parsing", () => {
  test("unfolds continuation lines and lowercases names", () => {
    const parsed = parseHeaders(
      encode("Subject: one\r\n  two\r\nFrom: ada@acme.example\r\n\r\nbody"),
    );
    expect(parsed.fields).toEqual([
      { name: "subject", value: "one two" },
      { name: "from", value: "ada@acme.example" },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  test("accepts bare LF folding with a tab", () => {
    const parsed = parseHeaders(encode("Subject: one\n\ttwo\n\nbody"));
    expect(headerValue(parsed.fields, "subject")).toBe("one two");
  });

  test("keeps repeated fields in order", () => {
    const parsed = parseHeaders(
      encode("Received: a\r\nReceived: b\r\nReceived: c\r\n\r\n"),
    );
    expect(headerValues(parsed.fields, "received")).toEqual(["a", "b", "c"]);
  });

  test("reports the body offset and handles a header-only capture", () => {
    const parsed = parseHeaders(encode("Subject: x\r\n\r\nhello"));
    expect(parsed.bodyOffset).toBe("Subject: x\r\n\r\n".length);
    const headerOnly = parseHeaders(encode("Subject: x\r\n"));
    expect(headerOnly.bodyOffset).toBe("Subject: x\r\n".length);
    expect(headerOnly.fields).toHaveLength(1);
  });

  test("caps the field count and flags the truncation", () => {
    const many = Array.from(
      { length: MAX_HEADER_FIELDS + 5 },
      (_unused, index) => `X-N-${index}: v`,
    ).join("\r\n");
    const parsed = parseHeaders(encode(`${many}\r\n\r\n`));
    expect(parsed.fields).toHaveLength(MAX_HEADER_FIELDS);
    expect(parsed.truncated).toBe(true);
  });

  test("caps the header byte budget", () => {
    const filler = "X-Long: ".concat("a".repeat(70_000));
    const parsed = parseHeaders(encode(`${filler}\r\nSubject: late\r\n\r\n`));
    expect(parsed.truncated).toBe(true);
    expect(headerValue(parsed.fields, "subject")).toBeUndefined();
  });

  test("ignores a line without a colon", () => {
    const parsed = parseHeaders(encode("garbage\r\nSubject: x\r\n\r\n"));
    expect(parsed.fields).toEqual([{ name: "subject", value: "x" }]);
  });
});
