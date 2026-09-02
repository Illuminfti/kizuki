import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import {
  MAX_LITERAL_BYTES,
  ResponseReader,
  parseResponse,
  tokenText,
} from "../src/imap/tokenizer";
import type { ImapConn } from "../src/transport";

function conn(chunks: string[]): ImapConn & { closed: boolean } {
  const queue = chunks.map((chunk) => new TextEncoder().encode(chunk));
  return {
    closed: false,
    async send() {},
    async receive() {
      return queue.shift() ?? null;
    },
    close() {
      this.closed = true;
    },
  };
}

describe("response tokenizer", () => {
  test("splits atoms, quoted strings, lists and NIL", () => {
    const response = parseResponse(
      '* LIST (\\HasNoChildren \\Noselect) "/" "INBOX" NIL',
      [],
    );
    expect(response.tag).toBe("*");
    expect(tokenText(response.items[0])).toBe("LIST");
    expect(response.items[1]).toEqual({
      kind: "list",
      items: [
        { kind: "atom", value: "\\HasNoChildren" },
        { kind: "atom", value: "\\Noselect" },
      ],
    });
    expect(tokenText(response.items[2])).toBe("/");
    expect(tokenText(response.items[3])).toBe("INBOX");
    expect(response.items[4]).toEqual({ kind: "nil" });
  });

  test("keeps escapes inside a quoted string and brackets inside an atom", () => {
    const response = parseResponse(
      'A1 OK "say \\"hi\\" \\\\ now" BODY[HEADER.FIELDS (FROM TO)]',
      [],
    );
    expect(tokenText(response.items[1])).toBe('say "hi" \\ now');
    expect(tokenText(response.items[2])).toBe("BODY[HEADER.FIELDS (FROM TO)]");
  });

  test("reads a literal that straddles chunk boundaries", async () => {
    const reader = new ResponseReader(
      conn(["* 1 FETCH (BODY[] {11}\r\nhel", "lo world)\r\n"]),
    );
    const response = await reader.next();
    expect(response).not.toBeNull();
    const fetch = response?.items[2];
    expect(fetch?.kind).toBe("list");
    if (fetch?.kind !== "list") return;
    expect(tokenText(fetch.items[1])).toBe("hello world");
  });

  test("accepts a non-synchronising literal", async () => {
    const reader = new ResponseReader(conn(["* OK {2+}\r\nhi\r\n"]));
    const response = await reader.next();
    expect(tokenText(response?.items[1])).toBe("hi");
  });

  test("reads consecutive responses and then reports EOF", async () => {
    const reader = new ResponseReader(conn(["* OK one\r\nA1 OK two\r\n"]));
    expect((await reader.next())?.tag).toBe("*");
    expect((await reader.next())?.tag).toBe("A1");
    expect(await reader.next()).toBeNull();
  });

  test("refuses a line over the bound and closes the connection", async () => {
    const socket = conn([`* OK ${"a".repeat(70_000)}\r\n`]);
    const reader = new ResponseReader(socket);
    await expect(reader.next()).rejects.toThrow(KizukiError);
    expect(socket.closed).toBe(true);
  });

  test("refuses an oversized literal and closes the connection", async () => {
    const socket = conn([`* OK {${MAX_LITERAL_BYTES + 1}}\r\n`]);
    const reader = new ResponseReader(socket);
    await expect(reader.next()).rejects.toThrow("literal exceeds bound");
    expect(socket.closed).toBe(true);
  });

  test("refuses a truncated literal", async () => {
    const reader = new ResponseReader(conn(["* OK {10}\r\nshort"]));
    await expect(reader.next()).rejects.toThrow(KizukiError);
  });
});
