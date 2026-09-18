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
    ["&2D3eAA-", "😀"],
    ["Caf&AOk- notes", "Café notes"],
  ])("decodes %s", (wire, display) => {
    expect(decodeModifiedUtf7(wire)).toBe(display);
  });

  test.each(["&AOk", "&!!-", "&", "&2AA-", "&3AA-", "&2AAA6Q-", "&3ADYAA-"])(
    "leaves the malformed run %s verbatim",
    (wire) => {
      expect(decodeModifiedUtf7(wire)).toBe(wire);
    },
  );

  test("preserves a malformed UTF-16 run between valid mailbox segments", () => {
    expect(decodeModifiedUtf7("Caf&AOk-/&2AA-/&ZeVnLIqe-")).toBe(
      "Café/&2AA-/日本語",
    );
  });
});
