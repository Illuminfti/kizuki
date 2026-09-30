import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { accept, readSince } from "../src/ledger/ledger";
import { commitMachineByteIntent } from "../src/ledger/event-origin";
import { machineBodyHash, machineImageHashes } from "../src/ledger/machine-image";
import { serializePage } from "../src/vault/frontmatter";
import { sha256Hex } from "../src/util/hash";
import { ulid } from "../src/util/ulid";
import { EVENT_LIMITS } from "../src/contracts/event";
import { validEvent } from "./fixtures";

// Real ledger and vault work; bound it for a loaded host.
setDefaultTimeout(30_000);

const PAGE = serializePage({
  data: { id: "01J0000000000000000000000A", status: "active", sensitivity: "personal", sources: ["01J0000000000000000000000B"], taint: "quoted", title: "Orchard notes", type: "topic" },
  body: "The orchard library opens on weekdays.\nVolunteers shelve returns on Fridays.\n",
});

function originOf(db: ReturnType<typeof openLedger>, text: string): string {
  const source_record_id = `copy-${ulid()}`;
  expect(accept(db, { ...validEvent(), source_record_id, text }).status).toBe("stored");
  return readSince(db, null, 100).events.find(event => event.source_record_id === source_record_id)!.origin;
}

function ledgerWithPage() {
  const db = openLedger(":memory:");
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(PAGE) }, () => {}, { before: null, after: PAGE });
  return db;
}

describe("self origin survives trivial edits", () => {
  test("the registered bytes are self and an unrelated note is external", () => {
    const db = ledgerWithPage();
    try {
      expect(originOf(db, PAGE)).toBe("self");
      expect(originOf(db, "A note about something else entirely.\n")).toBe("external");
    } finally { db.close(); }
  });

  test.each([
    ["stripped frontmatter", (text: string) => text.slice(text.indexOf("\n---", 3) + 5)],
    ["rewritten frontmatter", (text: string) => text.replace(/title:.*\n/, "title: Copied notes\n")],
    ["metadata replaced entirely", (text: string) => `---\nchanged: true\n---\n${text.slice(text.indexOf("\n---", 3) + 5)}`],
    ["CRLF line endings", (text: string) => text.replace(/\n/g, "\r\n")],
    ["bare CR line endings", (text: string) => text.replace(/\n/g, "\r")],
    ["extra trailing newlines", (text: string) => `${text}\n\n\n`],
    ["no trailing newline", (text: string) => text.trimEnd()],
    ["trailing spaces on lines", (text: string) => text.replace(/\n/g, "  \n")],
    ["all of them at once", (text: string) => `${text.replace(/\n/g, " \r\n")}\r\n\r\n`],
  ])("%s", (_label, edit) => {
    const db = ledgerWithPage();
    try {
      expect(originOf(db, edit(PAGE))).toBe("self");
    } finally { db.close(); }
  });

  test("a changed word is a different document", () => {
    const db = ledgerWithPage();
    try {
      expect(originOf(db, PAGE.replace("weekdays", "Mondays"))).toBe("external");
      expect(originOf(db, `${PAGE}x`)).toBe("external");
      expect(originOf(db, " \n\t\r\n")).toBe("external");
    } finally { db.close(); }
  });

  test("body hashes ignore metadata but retain body meaning", () => {
    expect(machineBodyHash(PAGE)).toBe(machineBodyHash(PAGE.replace(/title:.*\n/, "title: Another title\n")));
    expect(machineBodyHash("---\nx: y\n---\n \t\n")).toBeNull();
    expect(machineBodyHash(PAGE)).not.toBe(machineBodyHash(PAGE.replace("weekdays", "Mondays")));
  });

  test("normalization candidates never include the empty image", () => {
    expect(machineImageHashes("  \n")).toEqual([]);
    expect(machineImageHashes("a\r\n")).toContain(sha256Hex("a\n"));
  });
});

describe("hostile whitespace", () => {
  test("a megabyte of spaces is hashed in bounded time", () => {
    const hostile = `${" ".repeat(EVENT_LIMITS.textBytes - 1)}x`;
    const db = ledgerWithPage();
    try {
      const started = performance.now();
      expect(originOf(db, hostile)).toBe("external");
      machineImageHashes(`${"\t ".repeat(500_000)}x\r\n`);
      expect(performance.now() - started).toBeLessThan(750);
    } finally { db.close(); }
  });

  test("trailing blanks are still stripped per line", () => {
    const stripped = machineImageHashes("a\nb\n");
    expect(machineImageHashes("a \t\nb  \r\n").some(hash => stripped.includes(hash))).toBe(true);
  });
});
