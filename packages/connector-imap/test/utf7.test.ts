import { describe, expect, test } from "bun:test";
import { decodeModifiedUtf7 } from "../src/imap/utf7";

describe("modified UTF-7 mailbox names", () => {
  test.each([
    ["&AOk-", "é"],
    ["&-", "&"],
    ["INBOX", "INBOX"],
    ["Archive/2026", "Archive/2026"],
    ["Sent &- Drafts", "Sent & Drafts"],
    ["&ZeVnLIqe-", "日本語"],
    ["Caf&AOk- notes", "Café notes"],
  ])("decodes %s", (wire, display) => {
    expect(decodeModifiedUtf7(wire)).toBe(display);
  });

  test.each(["&AOk", "&!!-", "&"])("leaves the malformed run %s verbatim", (wire) => {
    expect(decodeModifiedUtf7(wire)).toBe(wire);
  });
});
