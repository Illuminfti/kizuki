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

  test.each([
    [
      "keeps ISO-8859-1 across a later encoded segment",
      "attachment; filename*0*=iso-8859-1''caf; filename*1*=%E9.txt",
      "café.txt",
    ],
    [
      "reassembles a UTF-8 character split across segments",
      "attachment; filename*0*=utf-8''caf%C3; filename*1*=%A9.txt",
      "café.txt",
    ],
    [
      "mixes encoded segments with an unencoded suffix",
      "attachment; filename*0*=iso-8859-1''caf; filename*1*=%E9; filename*2=.txt",
      "café.txt",
    ],
    [
      "leaves an unencoded percent sign literal",
      "attachment; filename*0*=utf-8''budget; filename*1=%20.txt",
      "budget%20.txt",
    ],
  ])("%s", (_label, header, expected) => {
    expect(parseDisposition(header)?.params["filename"]).toBe(expected);
  });

  test("continued filename is independent of parameter order", () => {
    expect(
      parseDisposition(
        "attachment; filename*1*=%A9.txt; filename*0*=utf-8''caf%C3",
      )?.params["filename"],
    ).toBe("café.txt");
    expect(
      parseDisposition(
        "attachment; filename*2=.txt; filename*1*=%E9; filename*0*=iso-8859-1''caf",
      )?.params["filename"],
    ).toBe("café.txt");
  });

  test("joins unencoded continuations without percent-decoding", () => {
    const disposition = parseDisposition(
      "attachment; filename*0=hello; filename*1=.txt",
    );
    expect(disposition?.params["filename"]).toBe("hello.txt");
  });

  test.each([
    [
      "keeps ISO-8859-1 across a later encoded segment",
      "application/pdf; name*0*=iso-8859-1''caf; name*1*=%E9.txt",
      "café.txt",
    ],
    [
      "reassembles a UTF-8 character split across segments",
      "application/pdf; name*0*=utf-8''caf%C3; name*1*=%A9.txt",
      "café.txt",
    ],
    [
      "mixes encoded segments with an unencoded suffix",
      "application/pdf; name*0*=iso-8859-1''caf; name*1*=%E9; name*2=.txt",
      "café.txt",
    ],
    [
      "leaves an unencoded percent sign literal",
      "application/pdf; name*0*=utf-8''budget; name*1=%20.txt",
      "budget%20.txt",
    ],
    [
      "is independent of parameter order",
      "application/pdf; name*1*=%E9.txt; name*0*=iso-8859-1''caf",
      "café.txt",
    ],
  ])("Content-Type name %s", (_label, header, expected) => {
    expect(parseContentType(header).params["name"]).toBe(expected);
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

  test("an inner boundary that extends the outer one is not a delimiter", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: multipart/alternative; boundary=b1",
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "inner plain",
      "--b1--",
      "--b",
      "Content-Type: text/plain; name=note.txt",
      "",
      "attached",
      "--b--",
      "",
    ].join("\r\n");
    expect(leafPaths(parseMessage(encode(raw)).root)).toEqual(["1.1", "2"]);
  });

  test("a delimiter may carry transport padding but not more text", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=B",
      "",
      "--B  ",
      "Content-Type: text/plain",
      "",
      "one",
      "--Bx",
      "still one",
      "--B",
      "Content-Type: text/plain",
      "",
      "two",
      "--B--",
      "",
    ].join("\r\n");
    const message = parseMessage(encode(raw));
    expect(leafPaths(message.root)).toEqual(["1", "2"]);
    const first = message.root.children[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(partText(first, [])).toContain("still one");
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
    ["<SCRIPT >a</ SCRIPT >kept", "kept"],
    ["before<script>alert(1)", "before"],
    ["<script>a</script>mid<script>b</script>end", "mid end"],
    ["&amp;&lt;&gt;&quot;&#39;&apos;&nbsp;x", "&<>\"'' x"],
    ["&#65;&#x42;", "AB"],
    ["<div>a</div><div></div><div></div><div>b</div>", "a\n\nb"],
    ["<ul><li>one</li><li>two</li></ul>", "one\ntwo"],
    ["<h1>Title</h1>body", "Title\nbody"],
    ["&unknown;", "&unknown;"],
    ["over &#1114112; end", "over &#1114112; end"],
    ["over &#x110000; end", "over &#x110000; end"],
    ["lone &#55296; end", "lone &#55296; end"],
    ["lone &#xDFFF; end", "lone &#xDFFF; end"],
    ["proto &constructor; end", "proto &constructor; end"],
    ["proto &toString; end", "proto &toString; end"],
    ["proto &__proto__; end", "proto &__proto__; end"],
  ])("renders %s", (html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  test("an unclosed element costs the same as a closed one", () => {
    // The paired pattern this replaced backtracked to the end of the document
    // once per unclosed open tag, so one html-only message from any stranger
    // blocked the ingest loop for minutes.
    const hostile = "<script>x".repeat(20_000) + "y".repeat(200_000);
    const started = Bun.nanoseconds();
    expect(htmlToText(hostile)).toBe("");
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(1_000);
  }, 2_000);

  test("a hostile entity cannot abort the capture of a whole page", () => {
    expect(htmlToText("<p>before</p><p>&#1114112;</p><p>after</p>")).toBe(
      "before\n&#1114112;\nafter",
    );
  });
});
