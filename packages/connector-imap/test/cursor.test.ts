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

  test("a cursor written before retries existed decodes with no holes", () => {
    const { pending: _dropped, ...older } = CURSOR.folders["INBOX"] ?? {
      pending: "",
    };
    const raw = JSON.stringify({
      schema: "kizuki.imap-cursor/v1",
      folders: { INBOX: older },
    });
    expect(decodeCursor(raw).folders["INBOX"]?.pending).toBe("");
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
