import { describe, expect, test } from "bun:test";
import {
  MAX_MIME_PARTS,
  parseContentType,
  parseDisposition,
  parseMessage,
  partText,
} from "../../src/mime/parse";
import { htmlToText } from "../../src/mime/html";
import type { MimePart } from "../../src/mime/parse";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function leafPaths(part: MimePart, into: string[] = []): string[] {
  if (part.children.length === 0) into.push(part.path);
  for (const child of part.children) leafPaths(child, into);
  return into;
}

describe("content type parameters", () => {
  test("parses type, subtype and a quoted boundary", () => {
    const parsed = parseContentType(
      'Multipart/Alternative; Boundary="a;b c"; charset=utf-8',
    );
    expect(parsed.type).toBe("multipart");
    expect(parsed.subtype).toBe("alternative");
    expect(parsed.params["boundary"]).toBe("a;b c");
    expect(parsed.params["charset"]).toBe("utf-8");
  });

  test("defaults to text/plain and survives a malformed value", () => {
    expect(parseContentType(undefined)).toEqual({
      type: "text",
      subtype: "plain",
      params: {},
    });
    expect(parseContentType("garbage").type).toBe("text");
  });

  test("reassembles RFC 2231 continuations", () => {
    const disposition = parseDisposition(
      "attachment; filename*0*=utf-8''caf%C3%A9%20; filename*1*=report.pdf",
    );
    expect(disposition?.type).toBe("attachment");
    expect(disposition?.params["filename"]).toBe("café report.pdf");
  });

  test("decodes a single extended parameter", () => {
    const disposition = parseDisposition("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf");
    expect(disposition?.params["filename"]).toBe("résumé.pdf");
    expect(parseDisposition(undefined)).toBeNull();
  });
});

describe("multipart walk", () => {
  test("splits parts and prefers plain text in an alternative", () => {
    const raw = [
      "Content-Type: multipart/alternative; boundary=B",
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain body",
      "--B",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html body</p>",
      "--B--",
      "",
    ].join("\r\n");
    const message = parseMessage(encode(raw));
    expect(leafPaths(message.root)).toEqual(["1", "2"]);
    const plain = message.root.children[0];
    expect(plain).toBeDefined();
    if (plain === undefined) return;
    expect(partText(plain, []).trim()).toBe("plain body");
  });

  test("nests to a depth and numbers section paths", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=OUT",
      "",
      "--OUT",
      "Content-Type: multipart/alternative; boundary=IN",
      "",
      "--IN",
      "Content-Type: text/plain",
      "",
      "inner plain",
      "--IN--",
      "--OUT",
      "Content-Type: application/pdf; name=report.pdf",
      "",
      "%PDF",
      "--OUT--",
      "",
    ].join("\r\n");
    const message = parseMessage(encode(raw));
    expect(leafPaths(message.root)).toEqual(["1.1", "2"]);
  });

  test("caps the part count", () => {
    const parts = Array.from(
      { length: MAX_MIME_PARTS + 20 },
      () => "--B\r\nContent-Type: text/plain\r\n\r\nx",
    ).join("\r\n");
    const message = parseMessage(
      encode(`Content-Type: multipart/mixed; boundary=B\r\n\r\n${parts}\r\n--B--\r\n`),
    );
    expect(message.root.children.length).toBeLessThanOrEqual(MAX_MIME_PARTS);
    expect(message.root.children.length).toBeGreaterThan(0);
  });

  test("keeps message/rfc822 as a leaf rather than recursing", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=B",
      "",
      "--B",
      "Content-Type: message/rfc822",
      "",
      "Subject: enclosed",
      "",
      "enclosed body",
      "--B--",
      "",
    ].join("\r\n");
    const message = parseMessage(encode(raw));
    expect(leafPaths(message.root)).toEqual(["1"]);
    expect(message.root.children[0]?.contentType.subtype).toBe("rfc822");
  });

  test("decodes a base64 part body", () => {
    const raw = [
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "aGVsbG8gd29ybGQ=",
      "",
    ].join("\r\n");
    const message = parseMessage(encode(raw));
    expect(partText(message.root, []).trim()).toBe("hello world");
  });
});

describe("html to text", () => {
  test.each([
    ["<p>one</p><p>two</p>", "one\ntwo"],
    ["a<br>b", "a\nb"],
    ["<script>alert(1)</script>kept", "kept"],
    ["<style>p{}</style>kept", "kept"],
    ["&amp;&lt;&gt;&quot;&#39;&apos;&nbsp;x", "&<>\"'' x"],
    ["&#65;&#x42;", "AB"],
    ["<div>a</div><div></div><div></div><div>b</div>", "a\n\nb"],
    ["<ul><li>one</li><li>two</li></ul>", "one\ntwo"],
    ["<h1>Title</h1>body", "Title\nbody"],
    ["&unknown;", "&unknown;"],
  ])("renders %s", (html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });
});
