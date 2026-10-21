import { describe, expect, test } from "bun:test";
import { KizukiError, MAX_CURSOR_BYTES } from "@kizuki/core";
import {
  IMAP_CURSOR_SCHEMA,
  cursorStoreDelta,
  emptyCursor,
  encodeFolder,
  loadCursor,
  wireCursor,
} from "../src/cursor";
import type { ImapCursor, ImapFolderCursor } from "../src/cursor";

const INBOX: ImapFolderCursor = {
  uidvalidity: 7,
  scan_from: 341,
  uidnext: 901,
  known: "1:340",
  pending: "342",
  done: false,
};

const CURSOR: ImapCursor = {
  schema: IMAP_CURSOR_SCHEMA,
  folders: { INBOX },
};

/** What a host holds after committing a batch for `cursor`. */
function committed(cursor: ImapCursor): Map<string, string> {
  return new Map(
    Object.entries(cursorStoreDelta(new Map(), cursor) ?? {}) as [
      string,
      string,
    ][],
  );
}

function folderEntry(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...INBOX, ...overrides });
}

describe("cursor", () => {
  test("round-trips through the wire token and the host store", () => {
    expect(loadCursor(wireCursor(CURSOR), committed(CURSOR))).toEqual(CURSOR);
    const empty = emptyCursor();
    expect(loadCursor(wireCursor(empty), committed(empty))).toEqual(empty);
    expect(loadCursor(null, new Map())).toEqual(empty);
  });

  test("the wire token stays small however large the seen set grows", () => {
    const ranges: string[] = [];
    for (let uid = 1; uid <= 100_000; uid += 3)
      ranges.push(`${uid}:${uid + 1}`);
    const known = ranges.join(",");
    const cursor: ImapCursor = {
      schema: IMAP_CURSOR_SCHEMA,
      folders: { INBOX: { ...INBOX, known }, Archive: { ...INBOX, known } },
    };
    expect(known.length).toBeGreaterThan(MAX_CURSOR_BYTES);
    expect(wireCursor(cursor).length).toBeLessThan(200);
    expect(loadCursor(wireCursor(cursor), committed(cursor))).toEqual(cursor);
  });

  test("the token changes whenever any folder does, and only then", () => {
    const changed: ImapCursor = {
      ...CURSOR,
      folders: { INBOX: { ...INBOX, scan_from: 342 } },
    };
    expect(wireCursor(changed)).not.toBe(wireCursor(CURSOR));
    expect(wireCursor({ ...CURSOR, folders: { INBOX: { ...INBOX } } })).toBe(
      wireCursor(CURSOR),
    );
    const two: ImapCursor = { ...CURSOR, folders: { INBOX, Sent: INBOX } };
    const swapped: ImapCursor = { ...CURSOR, folders: { Sent: INBOX, INBOX } };
    expect(wireCursor(swapped)).toBe(wireCursor(two));
  });

  test("the delta carries only the folders that changed or left", () => {
    const held = committed({
      ...CURSOR,
      folders: { INBOX, Sent: INBOX, Old: INBOX },
    });
    expect(
      cursorStoreDelta(held, {
        ...CURSOR,
        folders: { INBOX, Sent: INBOX, Old: INBOX },
      }),
    ).toBeUndefined();
    const next: ImapCursor = {
      ...CURSOR,
      folders: { INBOX: { ...INBOX, scan_from: 400 }, Sent: INBOX },
    };
    expect(cursorStoreDelta(held, next)).toEqual({
      "folder:INBOX": encodeFolder(next.folders["INBOX"]!),
      "folder:Old": null,
    });
  });

  test("preserves literal mailbox names across a checkpoint restart", () => {
    for (const folder of ["__proto__", "constructor", "toString"]) {
      const cursor = emptyCursor();
      expect(cursor.folders[folder]).toBeUndefined();
      cursor.folders[folder] = { ...INBOX };

      const delta = cursorStoreDelta(new Map(), cursor);
      expect(Object.keys(delta ?? {})).toEqual([`folder:${folder}`]);
      const resumed = loadCursor(wireCursor(cursor), committed(cursor));
      expect(Object.hasOwn(resumed.folders, folder)).toBe(true);
      expect(resumed.folders[folder]).toEqual(INBOX);
      expect(Object.keys(resumed.folders)).toEqual([folder]);
      expect(wireCursor(resumed)).toBe(wireCursor(cursor));
    }
  });

  test("a store entry with no retry list fails closed", () => {
    const { pending: _dropped, ...incomplete } = INBOX;
    const store = new Map([["folder:INBOX", JSON.stringify(incomplete)]]);
    // Every field of an entry this connector minted is present; a missing one
    // means it came from somewhere else.
    expect(() => loadCursor(wireCursor(CURSOR), store)).toThrow(KizukiError);
  });

  test("rejects checkpoint numbers outside the nonzero 32-bit range", () => {
    for (const field of ["uidvalidity", "scan_from", "uidnext"] as const) {
      for (const value of [
        0,
        -1,
        1.5,
        4294967296,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const store = new Map([
          ["folder:INBOX", folderEntry({ [field]: value })],
        ]);
        expect(() => loadCursor(wireCursor(CURSOR), store)).toThrow(
          KizukiError,
        );
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
      expect(loadCursor(wireCursor(cursor), committed(cursor))).toEqual(cursor);
    }
  });

  test("rejects any deviation", () => {
    const wire = wireCursor(CURSOR);
    const good = committed(CURSOR);
    const badWire = [
      "{",
      "[]",
      JSON.stringify({
        schema: "kizuki.imap-cursor/v3",
        digest: "0".repeat(64),
      }),
      JSON.stringify({ schema: IMAP_CURSOR_SCHEMA }),
      JSON.stringify({ schema: IMAP_CURSOR_SCHEMA, digest: "abc" }),
      JSON.stringify({
        schema: IMAP_CURSOR_SCHEMA,
        digest: "0".repeat(64),
        folders: {},
      }),
    ];
    for (const raw of badWire) {
      expect(() => loadCursor(raw, good)).toThrow(KizukiError);
    }
    const badEntries = [
      "{",
      "[]",
      folderEntry({ extra: 1 }),
      folderEntry({ done: "yes" }),
      folderEntry({ scan_from: -1 }),
      folderEntry({ known: "1:" }),
      folderEntry({ pending: 3 }),
    ];
    for (const raw of badEntries) {
      expect(() => loadCursor(wire, new Map([["folder:INBOX", raw]]))).toThrow(
        KizukiError,
      );
    }
    expect(() =>
      loadCursor(wire, new Map([["other:INBOX", encodeFolder(INBOX)]])),
    ).toThrow(KizukiError);
  });

  test("a cursor from before the host store still reads, folders and all", () => {
    const legacy = JSON.stringify({
      schema: "kizuki.imap-cursor/v1",
      folders: { INBOX },
    });
    expect(loadCursor(legacy, new Map())).toEqual(CURSOR);
    // Moving it costs one delta; after that the store holds the folder.
    const delta = cursorStoreDelta(new Map(), loadCursor(legacy, new Map()));
    expect(delta).toEqual({ "folder:INBOX": encodeFolder(INBOX) });
    for (const raw of [
      JSON.stringify({ schema: "kizuki.imap-cursor/v1", folders: 3 }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...INBOX, extra: 1 } },
      }),
      JSON.stringify({
        schema: "kizuki.imap-cursor/v1",
        folders: { INBOX: { ...INBOX, known: "1:" } },
      }),
    ]) {
      expect(() => loadCursor(raw, new Map())).toThrow(KizukiError);
    }
  });
});
