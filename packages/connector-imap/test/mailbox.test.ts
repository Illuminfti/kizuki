import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import type { CaptureEventInput, Cursor } from "@kizuki/core";
import { BATCH, walkMailboxes } from "../src/mailbox";
import { decodeCursor } from "../src/cursor";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../src/state";
import type { ImapState } from "../src/state";
import { FakeImapServer } from "../src/testing/fake-imap";
import type { FakeFolder } from "../src/testing/fake-imap";
import { fixtureServer, fixtureState } from "../src/testing";
import { memoryDialer } from "../src/testing/memory-dialer";

const NOW = (): Date => new Date("2026-03-02T00:00:00.000Z");
const encoder = new TextEncoder();

function message(
  uid: number,
  subject: string,
): {
  uid: number;
  internaldate: string;
  raw: Uint8Array;
} {
  return {
    uid,
    internaldate: "01-Mar-2026 08:00:00 +0000",
    raw: encoder.encode(
      [
        "From: Ada <ada@acme.example>",
        "To: grace@acme.example",
        `Subject: ${subject}`,
        "Date: Sun, 01 Mar 2026 08:00:00 +0000",
        `Message-ID: <${uid}@acme.example>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Body of ${subject}`,
        "",
      ].join("\r\n"),
    ),
  };
}

function folder(wire: string, count: number, uidvalidity = 5): FakeFolder {
  return {
    wire,
    attributes: ["\\HasNoChildren"],
    uidvalidity,
    uidnext: count + 1,
    messages: Array.from({ length: count }, (_unused, index) =>
      message(index + 1, `note ${index + 1}`),
    ),
  };
}

function state(
  folders: string[],
  overrides: Partial<ImapState> = {},
): ImapState {
  return {
    schema: "kizuki.imap-state/v1",
    host: "mail.acme.example",
    port: 993,
    username: "ada@acme.example",
    password: "app-password",
    folders,
    max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
    ...overrides,
  };
}

function deps(server: FakeImapServer, imapState: ImapState) {
  return { dial: memoryDialer(server), state: imapState, now: NOW };
}

function uidsOf(events: CaptureEventInput[]): number[] {
  return events.map((event) => event.metadata["uid"] as number);
}

describe("backfill paging", () => {
  test("walks 450 messages in pages of 200, 200 and 50 with no repeats", async () => {
    const server = new FakeImapServer([folder("INBOX", 450)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const seen: number[] = [];
    let cursor: Cursor | null = null;
    const sizes: number[] = [];

    for (let page = 0; page < 3; page += 1) {
      const result = await walkMailboxes(walkDeps, cursor, "backfill");
      sizes.push(result.batch.events.length);
      seen.push(...uidsOf(result.batch.events));
      cursor = result.batch.cursor;
    }

    expect(sizes).toEqual([BATCH, BATCH, 50]);
    expect(seen).toHaveLength(450);
    expect(new Set(seen).size).toBe(450);
    expect(seen[0]).toBe(1);
    expect(seen[449]).toBe(450);
  });

  test("a completed backfill returns an empty batch and an unchanged cursor", async () => {
    const server = new FakeImapServer([folder("INBOX", 3)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const first = await walkMailboxes(walkDeps, null, "backfill");
    expect(first.batch.events).toHaveLength(3);

    const second = await walkMailboxes(
      walkDeps,
      first.batch.cursor,
      "backfill",
    );
    expect(second.batch.events).toEqual([]);
    expect(second.batch.cursor).toBe(first.batch.cursor);
  });

  test("backfill(null) twice yields the same first page", async () => {
    const server = new FakeImapServer([folder("INBOX", 5)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const first = await walkMailboxes(walkDeps, null, "backfill");
    const again = await walkMailboxes(walkDeps, null, "backfill");
    expect(again.batch).toEqual(first.batch);
  });

  test("walks the second configured folder after the first", async () => {
    const server = new FakeImapServer([
      folder("INBOX", 2),
      folder("Archive", 3, 9),
    ]);
    const result = await walkMailboxes(
      deps(server, state(["INBOX", "Archive"])),
      null,
      "backfill",
    );
    expect(result.batch.events.map((event) => event.source_record_id)).toEqual([
      "5:1:INBOX",
      "5:2:INBOX",
      "9:1:Archive",
      "9:2:Archive",
      "9:3:Archive",
    ]);
  });

  test("captures a message above the size bound header-only", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)]);
    const result = await walkMailboxes(
      deps(server, state(["INBOX"], { max_message_bytes: 100 })),
      null,
      "backfill",
    );
    for (const event of result.batch.events) {
      expect(event.metadata["body_omitted"]).toBe("size");
      expect(event.text).not.toContain("Body of");
    }
  });
});

describe("sync", () => {
  test("pages new mail once uidnext grows", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const first = await walkMailboxes(walkDeps, null, "backfill");
    server.append("INBOX", "Subject: fresh\r\n\r\nnew mail\r\n");

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    expect(uidsOf(second.batch.events)).toEqual([3]);
    expect(
      decodeCursor(second.batch.cursor ?? "").folders["INBOX"]?.known,
    ).toBe("1:3");
  });

  test("emits one tombstone per expunged uid and shrinks the known set", async () => {
    const server = new FakeImapServer([folder("INBOX", 4)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const first = await walkMailboxes(walkDeps, null, "backfill");
    server.expunge("INBOX", 2);
    server.expunge("INBOX", 3);

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    expect(second.batch.events).toHaveLength(2);
    expect(second.batch.events.every((event) => event.deleted)).toBe(true);
    expect(uidsOf(second.batch.events)).toEqual([2, 3]);
    expect(
      decodeCursor(second.batch.cursor ?? "").folders["INBOX"]?.known,
    ).toBe("1,4");
  });

  test("a uidvalidity reset tombstones the old ids then re-emits", async () => {
    const server = new FakeImapServer([folder("INBOX", 3)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const first = await walkMailboxes(walkDeps, null, "backfill");
    server.resetUidValidity("INBOX");

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    const tombstones = second.batch.events.filter((event) => event.deleted);
    const fresh = second.batch.events.filter((event) => !event.deleted);
    expect(tombstones.map((event) => event.source_record_id)).toEqual([
      "5:1:INBOX",
      "5:2:INBOX",
      "5:3:INBOX",
    ]);
    expect(
      tombstones.every((event) => event.metadata["uidvalidity_reset"]),
    ).toBe(true);
    expect(fresh.map((event) => event.source_record_id)).toEqual([
      "6:1:INBOX",
      "6:2:INBOX",
      "6:3:INBOX",
    ]);
    expect(second.notes).toEqual(["uidvalidity changed: INBOX"]);
  });

  test("a body the server withholds is retried, not walked past", async () => {
    const server = new FakeImapServer([folder("INBOX", 3)]);
    const walkDeps = deps(server, state(["INBOX"]));
    server.withholdBody("INBOX", 2);

    const first = await walkMailboxes(walkDeps, null, "backfill");
    expect(uidsOf(first.batch.events)).toEqual([1, 3]);
    expect(first.notes).toEqual(["message bodies not returned: INBOX (1)"]);

    // The UID never entered `known`, so no tombstone claims it was deleted;
    // it waits on the retry list instead, which is the only handle left on it.
    const held = decodeCursor(first.batch.cursor ?? "").folders["INBOX"];
    expect(held?.known).toBe("1,3");
    expect(held?.pending).toBe("2");

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    expect(second.batch.events).toEqual([]);
    expect(second.notes).toEqual(["message bodies not returned: INBOX (1)"]);

    server.restoreBody("INBOX", 2);
    const third = await walkMailboxes(walkDeps, second.batch.cursor, "sync");
    expect(uidsOf(third.batch.events)).toEqual([2]);
    expect(third.notes).toEqual([]);
    const healed = decodeCursor(third.batch.cursor ?? "").folders["INBOX"];
    expect(healed?.known).toBe("1:3");
    expect(healed?.pending).toBe("");
  });

  test("a retried message counts against the page's event budget", async () => {
    const server = new FakeImapServer([folder("INBOX", BATCH + 60)]);
    const walkDeps = deps(server, state(["INBOX"]));
    server.withholdBody("INBOX", 3);

    const first = await walkMailboxes(walkDeps, null, "backfill");
    // One short of a full page: the withheld message produced no event.
    expect(first.batch.events).toHaveLength(BATCH - 1);

    server.restoreBody("INBOX", 3);
    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    // The retried hole comes out of the same budget as the new page, or a
    // walk could hand the runner more than one batch's worth of events.
    expect(second.batch.events.length).toBeLessThanOrEqual(BATCH);
    expect(uidsOf(second.batch.events)).toContain(3);
  });

  test("a page that retries holes still scans the rest of its budget", async () => {
    const holes = 100;
    const server = new FakeImapServer([folder("INBOX", 4 * BATCH)]);
    const walkDeps = deps(server, state(["INBOX"]));
    for (let uid = 1; uid <= holes; uid += 1) server.withholdBody("INBOX", uid);

    const first = await walkMailboxes(walkDeps, null, "backfill");
    expect(first.batch.events).toHaveLength(BATCH - holes);
    const held = decodeCursor(first.batch.cursor ?? "").folders["INBOX"];
    expect(held?.scan_from).toBe(BATCH + 1);

    for (let uid = 1; uid <= holes; uid += 1) server.restoreBody("INBOX", uid);
    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    // The retried events are charged once, not twice: a walk that retried a
    // hole used to make no scan progress at all on that call.
    expect(second.batch.events).toHaveLength(BATCH);
    const advanced = decodeCursor(second.batch.cursor ?? "").folders["INBOX"];
    expect(advanced?.scan_from).toBe(BATCH + holes + 1);
  });

  test("a message expunged before its body arrived leaves the retry list", async () => {
    const server = new FakeImapServer([folder("INBOX", 3)]);
    const walkDeps = deps(server, state(["INBOX"]));
    server.withholdBody("INBOX", 2);

    const first = await walkMailboxes(walkDeps, null, "backfill");
    expect(decodeCursor(first.batch.cursor ?? "").folders["INBOX"]?.pending).toBe(
      "2",
    );

    server.expunge("INBOX", 2);
    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    // Nothing was ever emitted for it, so its disappearance is not a deletion.
    expect(second.batch.events).toEqual([]);
    expect(second.notes).toEqual([]);
    expect(
      decodeCursor(second.batch.cursor ?? "").folders["INBOX"]?.pending,
    ).toBe("");
  });

  test("a uid outside the window asked for cannot end the walk", async () => {
    const wide: FakeFolder = {
      wire: "INBOX",
      attributes: ["\\HasNoChildren"],
      uidvalidity: 1,
      uidnext: 1001,
      messages: Array.from({ length: 300 }, (_unused, index) =>
        message(5000 + index, `far ${index}`),
      ),
    };
    const server = new FakeImapServer([wide], { fetchIgnoresRange: true });
    const result = await walkMailboxes(
      deps(server, state(["INBOX"])),
      null,
      "backfill",
    );
    // The reply names UIDs the walk never asked about. Trusting them used to
    // set scan_from past 5000 and mark the mailbox done, leaving 1..1000
    // unreachable for the life of the cursor.
    expect(result.batch.events).toEqual([]);
    const entry = decodeCursor(result.batch.cursor ?? "").folders["INBOX"];
    expect(entry?.scan_from).toBe(1001);
    expect(entry?.known).toBe("");
    expect(entry?.done).toBe(true);
  });

  test("a decorated body section is still read as the body", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)], {
      decorateBodySection: true,
    });
    const result = await walkMailboxes(
      deps(server, state(["INBOX"])),
      null,
      "backfill",
    );
    expect(uidsOf(result.batch.events)).toEqual([1, 2]);
    expect(result.notes).toEqual([]);
  });

  test("a bulk expunge is paged like everything else", async () => {
    const server = new FakeImapServer([folder("INBOX", 300)]);
    const walkDeps = deps(server, state(["INBOX"]));
    let cursor: Cursor | null = null;
    for (let page = 0; page < 2; page += 1) {
      cursor = (await walkMailboxes(walkDeps, cursor, "backfill")).batch.cursor;
    }
    expect(decodeCursor(cursor ?? "").folders["INBOX"]?.known).toBe("1:300");

    for (let uid = 1; uid <= 300; uid += 1) server.expunge("INBOX", uid);

    const first = await walkMailboxes(walkDeps, cursor, "sync");
    expect(first.batch.events).toHaveLength(BATCH);
    expect(first.batch.events.every((event) => event.deleted)).toBe(true);
    expect(decodeCursor(first.batch.cursor ?? "").folders["INBOX"]?.known).toBe(
      "201:300",
    );

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    expect(second.batch.events).toHaveLength(100);
    expect(uidsOf(second.batch.events)[0]).toBe(201);
    expect(decodeCursor(second.batch.cursor ?? "").folders["INBOX"]?.known).toBe(
      "",
    );

    const third = await walkMailboxes(walkDeps, second.batch.cursor, "sync");
    expect(third.batch.events).toEqual([]);
  });

  test("a uidvalidity reset pages its tombstones before re-walking", async () => {
    const server = new FakeImapServer([folder("INBOX", 250)]);
    const walkDeps = deps(server, state(["INBOX"]));
    let cursor: Cursor | null = null;
    for (let page = 0; page < 2; page += 1) {
      cursor = (await walkMailboxes(walkDeps, cursor, "backfill")).batch.cursor;
    }
    server.resetUidValidity("INBOX");

    const first = await walkMailboxes(walkDeps, cursor, "sync");
    expect(first.batch.events).toHaveLength(BATCH);
    expect(first.batch.events.every((event) => event.deleted)).toBe(true);
    expect(
      first.batch.events.every((event) => event.metadata["uidvalidity_reset"]),
    ).toBe(true);
    expect(uidsOf(first.batch.events)).toEqual(
      Array.from({ length: BATCH }, (_unused, index) => index + 1),
    );

    const second = await walkMailboxes(walkDeps, first.batch.cursor, "sync");
    const tombstones = second.batch.events.filter((event) => event.deleted);
    const fresh = second.batch.events.filter((event) => !event.deleted);
    expect(tombstones).toHaveLength(50);
    expect(uidsOf(tombstones)[0]).toBe(201);
    expect(fresh).toHaveLength(150);
    expect(fresh[0]?.source_record_id).toBe("6:1:INBOX");
  });

  test("sync from a null cursor behaves like a fresh backfill", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)]);
    const walkDeps = deps(server, state(["INBOX"]));
    const result = await walkMailboxes(walkDeps, null, "sync");
    expect(result.batch.events).toHaveLength(2);
  });
});

describe("read-only discipline and failures", () => {
  test("uses EXAMINE and BODY.PEEK and never a mutating command", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)]);
    await walkMailboxes(deps(server, state(["INBOX"])), null, "backfill");
    const log = server.received.join("\n");
    expect(log).toContain("EXAMINE");
    expect(log).toContain("BODY.PEEK[]");
    expect(log).not.toMatch(/\sBODY\[/);
    expect(log).not.toMatch(/\sSELECT\s/);
    expect(log).not.toMatch(/\sSTORE\s/);
    expect(log).not.toMatch(/\sEXPUNGE\s/);
    expect(log).not.toMatch(/\sAPPEND\s/);
  });

  test("never scans with an open-ended range", async () => {
    const server = new FakeImapServer([folder("INBOX", 2)]);
    await walkMailboxes(deps(server, state(["INBOX"])), null, "backfill");
    expect(server.received.join("\n")).not.toContain(":*");
  });

  test("a mid-walk failure propagates and leaves the caller's cursor valid", async () => {
    const server = new FakeImapServer([folder("INBOX", 3)]);
    const walkDeps = deps(server, state(["INBOX", "Missing"]));
    const error = await walkMailboxes(walkDeps, null, "backfill").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(KizukiError);
    const fine = await walkMailboxes(
      deps(server, state(["INBOX"])),
      null,
      "backfill",
    );
    expect(fine.batch.events).toHaveLength(3);
  });
});

describe("bytes on the wire", () => {
  test("an 8-bit body survives the literal framing intact", async () => {
    const server = fixtureServer();
    const result = await walkMailboxes(
      deps(server, fixtureState()),
      null,
      "backfill",
    );
    const event = result.batch.events.find(
      (candidate) => candidate.source_record_id === "42:14:INBOX",
    );
    expect(event?.text).toBe("Café order\n\nUne pièce de résistance.");
  });
});
