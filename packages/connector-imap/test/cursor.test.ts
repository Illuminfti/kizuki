import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import { decodeCursor, emptyCursor, encodeCursor } from "../src/cursor";
import type { ImapCursor } from "../src/cursor";

const CURSOR: ImapCursor = {
  schema: "kizuki.imap-cursor/v1",
  folders: {
    INBOX: {
      uidvalidity: 7,
      scan_from: 341,
      uidnext: 901,
      known: "1:340",
      pending: "342",
      done: false,
    },
  },
};

describe("cursor", () => {
  test("round-trips", () => {
    expect(decodeCursor(encodeCursor(CURSOR))).toEqual(CURSOR);
    expect(decodeCursor(encodeCursor(emptyCursor()))).toEqual(emptyCursor());
  });

  test("preserves literal mailbox names across checkpoint restart", () => {
    for (const folder of ["__proto__", "constructor", "toString"]) {
      const cursor = emptyCursor();
      expect(cursor.folders[folder]).toBeUndefined();
      cursor.folders[folder] = { ...CURSOR.folders["INBOX"]! };

      const resumed = decodeCursor(encodeCursor(cursor));
      expect(Object.hasOwn(resumed.folders, folder)).toBe(true);
      expect(resumed.folders[folder]).toEqual(CURSOR.folders["INBOX"]);
      expect(Object.keys(resumed.folders)).toEqual([folder]);
      expect(encodeCursor(resumed)).toBe(encodeCursor(cursor));
    }
  });

  test("refuses a folder entry with no retry list", () => {
    const { pending: _dropped, ...incomplete } = CURSOR.folders["INBOX"] ?? {
      pending: "",
    };
    const raw = JSON.stringify({
      schema: "kizuki.imap-cursor/v1",
      folders: { INBOX: incomplete },
    });
    // Every field of a cursor this connector minted is present; a missing one
    // means the cursor came from somewhere else, and it fails closed.
    expect(() => decodeCursor(raw)).toThrow(KizukiError);
  });

  test("rejects checkpoint numbers outside the nonzero 32-bit range", () => {
    for (const field of ["uidvalidity", "scan_from", "uidnext"] as const) {
      for (const value of [0, -1, 1.5, 4294967296, Number.MAX_SAFE_INTEGER + 1]) {
        const raw = JSON.stringify({
          ...CURSOR,
          folders: { INBOX: { ...CURSOR.folders["INBOX"], [field]: value } },
        });
        expect(() => decodeCursor(raw)).toThrow(KizukiError);
      }
    }
  });

  test("preserves checkpoint numeric boundaries across restart", () => {
    for (const value of [1, 4294967295]) {
      const cursor: ImapCursor = {
        ...CURSOR,
        folders: {
          INBOX: {
            uidvalidity: value,
            scan_from: value,
            uidnext: value,
            known: "",
            pending: "",
            done: true,
          },
        },
      };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    }
  });

  test("rejects any deviation", () => {
    const deviations = [
      "{",
      "[]",
      JSON.stringify({ schema: "kizuki.imap-cursor/v2", folders: {} }),
      JSON.stringify({ schema: "kizuki.imap-cursor/v1", folders: 3 }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...CURSOR.folders["INBOX"], extra: 1 } },
      }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...CURSOR.folders["INBOX"], done: "yes" } },
      }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...CURSOR.folders["INBOX"], scan_from: -1 } },
      }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...CURSOR.folders["INBOX"], known: "1:" } },
      }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...CURSOR.folders["INBOX"], pending: 3 } },
      }),
    ];
    for (const raw of deviations) {
      expect(() => decodeCursor(raw)).toThrow(KizukiError);
    }
  });
});
