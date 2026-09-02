import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { readBoundedUtf8 } from "../src/read";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  MESSAGE_START,
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  chatNameFromFile,
  createWhatsAppImportConnector,
  fsMediaLookup,
  mapMediaLookup,
  parseWhatsAppExport,
} from "../src/import-whatsapp";

const CHAT_FILE = "WhatsApp Chat with Acme Planning.txt";
const FIXTURE_CHAT = WHATSAPP_FIXTURE_FILES[CHAT_FILE] ?? "";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-whatsapp-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejected(body: () => Promise<unknown>): Promise<KizukiError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

function parse(
  text: string,
  overrides: Partial<Parameters<typeof parseWhatsAppExport>[1]> = {},
): Promise<CaptureEventInput[]> {
  return parseWhatsAppExport(text, {
    timezone: WHATSAPP_FIXTURE_TIMEZONE,
    chat: "Acme Planning",
    observed_at: FIXTURE_OBSERVED_AT,
    media: mapMediaLookup({}),
    ...overrides,
  });
}

async function fixtureEvents(): Promise<CaptureEventInput[]> {
  return createWhatsAppImportConnector({ path: "/nonexistent" }).fixture();
}

test("the fixture export maps to eight events", async () => {
  const events = await fixtureEvents();
  expect(events.length).toBe(8);
  expect(events.map((event) => event.occurred_at)).toEqual([
    "2026-01-04T09:15:00.000Z",
    "2026-01-04T09:16:00.000Z",
    "2026-01-04T09:16:00.000Z",
    "2026-01-04T09:16:00.000Z",
    "2026-01-04T09:20:00.000Z",
    "2026-01-04T09:21:00.000Z",
    "2026-01-13T18:05:00.000Z",
    "2026-02-01T00:00:00.000Z",
  ]);
  expect(events.map((event) => event.text)).toEqual([
    "Morning all. Planning for the acme launch starts today.",
    "Morning! Two things:\n- venue\n- budget",
    "ok",
    "ok",
    "IMG-20260104-WA0001.jpg (file attached)",
    "<Media omitted>",
    "Venue booked for the 20th. Café Kōan, 18:00.",
    "Reminder: budget review at noon.",
  ]);
  for (const event of events) {
    expect(event.connector_id).toBe(WHATSAPP_IMPORT_CONNECTOR_ID);
    expect(event.kind).toBe("message");
    expect(event.sensitivity_hint).toBe("private");
    expect(event.deleted).toBe(false);
    expect(event.observed_at).toBe(FIXTURE_OBSERVED_AT);
    expect(event.source_record_id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\/[0-9a-f]{16}\/\d+$/,
    );
    expect(validateEventInput(event).ok).toBe(true);
  }
});

test("the subjects of a message are its sender and its chat", async () => {
  const events = await fixtureEvents();
  // The digest is of the display name alone, so the same participant keeps
  // one id across exports and across machines.
  expect(events[0]?.subjects).toEqual([
    {
      subject_id: "whatsapp:ada-99a563ab",
      role: "from",
      display_name: "Ada",
    },
    {
      subject_id: "whatsapp:chat:acme-planning-717e5439",
      role: "about",
      display_name: "Acme Planning",
    },
  ]);
});

test("participants a slug cannot tell apart stay separate subjects", async () => {
  // Punctuation and letterless names are exactly what a readable slug throws
  // away, and a purge reaches everything filed under one subject id.
  const chat = [
    "1/4/26, 09:00 - A B: one",
    "1/4/26, 09:01 - A-B: two",
    "1/4/26, 09:02 - \u{1f642}: three",
    "1/4/26, 09:03 - \u{1f44d}: four",
  ].join("\n");
  const events = await parse(chat, { date_order: "mdy" });
  const ids = events.map((event) => event.subjects[0]?.subject_id ?? "");
  expect(new Set(ids).size).toBe(4);
  expect(ids[0]?.startsWith("whatsapp:a-b-")).toBe(true);
  expect(ids[1]?.startsWith("whatsapp:a-b-")).toBe(true);
  for (const id of ids.slice(2)) {
    expect(id.startsWith("whatsapp:unknown-")).toBe(true);
  }
});

test("two identical messages in one minute are numbered, not merged", async () => {
  const events = await fixtureEvents();
  const [first, second] = [events[2], events[3]];
  expect(first?.source_record_id.replace(/\d$/, "")).toBe(
    second?.source_record_id.replace(/\d$/, ""),
  );
  expect(first?.source_record_id.endsWith("/1")).toBe(true);
  expect(second?.source_record_id.endsWith("/2")).toBe(true);
});

test("an attached file present beside the chat becomes one reference", async () => {
  const events = await fixtureEvents();
  expect(events[4]?.attachments).toEqual([
    {
      attachment_id: "IMG-20260104-WA0001.jpg",
      media_type: "image/jpeg",
      filename: "IMG-20260104-WA0001.jpg",
      byte_size: 26,
    },
  ]);
  expect(events[4]?.metadata["media"]).toBe("file");
  expect(events[4]?.metadata["filename"]).toBe("IMG-20260104-WA0001.jpg");
});

test("media left out of the export is recorded, not invented", async () => {
  const events = await fixtureEvents();
  expect(events[5]?.attachments).toEqual([]);
  expect(events[5]?.metadata["media"]).toBe("omitted");
  expect(events[5]?.metadata["filename"]).toBeNull();
});

test("the bracketed export format parses with seconds and a stripped mark", async () => {
  await withTempRoot(async (root) => {
    const media = "00000002-PHOTO-2026-01-04-09-16-30.jpg";
    await writeFile(path.join(root, media), "0123456789");
    const events = await parse(
      [
        "[04/01/2026, 09:15:00] Ada: Morning all.",
        `[13/01/2026, 09:16:30] Grace: \u200E<attached: ${media}>`,
      ].join("\n"),
      { media: fsMediaLookup(root) },
    );
    expect(events.map((event) => event.occurred_at)).toEqual([
      "2026-01-04T09:15:00.000Z",
      "2026-01-13T09:16:30.000Z",
    ]);
    expect(events[1]?.text).toBe(`<attached: ${media}>`);
    expect(events[1]?.attachments).toEqual([
      {
        attachment_id: media,
        media_type: "image/jpeg",
        filename: media,
        byte_size: 10,
      },
    ]);
  });
});

test("a continuation line before the first message is dropped", async () => {
  const events = await parse(
    ["stray line", "4/1/26, 09:00 - Ada: hi", "and more"].join("\n"),
    { date_order: "dmy" },
  );
  expect(events.length).toBe(1);
  expect(events[0]?.text).toBe("hi\nand more");
});

test("carriage returns do not change a single event", async () => {
  await withTempRoot(async (root) => {
    const lfPath = path.join(root, CHAT_FILE);
    const crlfPath = path.join(root, "crlf", CHAT_FILE);
    await mkdir(path.join(root, "crlf"));
    await writeFile(lfPath, FIXTURE_CHAT);
    await writeFile(crlfPath, FIXTURE_CHAT.replace(/\n/g, "\r\n"));
    const lf = await parse(
      await readBoundedUtf8(lfPath, WHATSAPP_IMPORT_CONNECTOR_ID),
    );
    const crlf = await parse(
      await readBoundedUtf8(crlfPath, WHATSAPP_IMPORT_CONNECTOR_ID),
    );
    expect(crlf).toEqual(lf);
  });
});

test("the newline a file ends on is a terminator, the next one is text", async () => {
  const chat = "1/4/26, 9:15 AM - Ada: hi";
  const bare = await parse(chat, { date_order: "mdy" });
  expect(bare[0]?.text).toBe("hi");
  // One newline ends the file's last line. Every newline after it is a blank
  // continuation line, which the export wrote and the message says, so it is
  // kept verbatim and the message is a different record for having it.
  expect((await parse(`${chat}\n`, { date_order: "mdy" }))[0]).toEqual(
    bare[0] as CaptureEventInput,
  );
  for (const [suffix, text] of [
    ["\n\n", "hi\n"],
    ["\n\n\n", "hi\n\n"],
  ] as const) {
    const events = await parse(`${chat}${suffix}`, { date_order: "mdy" });
    expect(events[0]?.text).toBe(text);
    expect(events[0]?.source_record_id).not.toBe(bare[0]?.source_record_id);
  }
});

test("a message start is every shape the two apps write, and nothing else", () => {
  const rest = "Ada: hi";
  for (const line of [
    "1/4/26, 9:15 AM - Ada: hi",
    "13.01.2026, 18:05 - Ada: hi",
    "2026-01-13, 18:05 - Ada: hi",
    "1/13/26, 6:05\u202FPM - Ada: hi",
    "1/4/26, 9:15\u00a0a.m. - Ada: hi",
    "1/4/26, 9:15 p. m. - Ada: hi",
  ]) {
    const matched = MESSAGE_START.exec(line);
    expect(matched?.[2]).toBe(line.slice(0, line.indexOf(" - ")));
    expect(matched?.[3]).toBe(rest);
  }
  const bracketed = MESSAGE_START.exec("[04/01/2026, 09:15:00] Ada: hi");
  expect(bracketed?.[1]).toBe("04/01/2026, 09:15:00");
  expect(bracketed?.[3]).toBe(rest);
  for (const line of [
    "- venue",
    "just some prose",
    "9:15 - Ada: hi",
    " 1/4/26, 9:15 AM - Ada: hi",
    "1/4/26 - Ada: hi",
  ]) {
    expect(MESSAGE_START.exec(line)).toBeNull();
  }
});

test("system notices are skipped and never become events", async () => {
  const events = await parse(FIXTURE_CHAT);
  expect(
    events.some((event) => event.text.includes("end-to-end encrypted")),
  ).toBe(false);
  const noticesOnly = await parse(
    "4/1/26, 09:00 - Messages and calls are end-to-end encrypted.",
    { date_order: "dmy" },
  );
  expect(noticesOnly).toEqual([]);
});

test("the dates of a notice settle nothing and refuse nothing", async () => {
  // A notice is dropped, so its date is not evidence for the order and not a
  // line that can fail under it. An export holding only notices is empty
  // rather than ambiguous, and a notice a longer export carries cannot refuse
  // the messages around it.
  expect(
    await parse("4/1/26, 09:00 - Messages and calls are end-to-end encrypted."),
  ).toEqual([]);

  const events = await parse(
    [
      "1/13/26, 09:00 - Ada: hello",
      "31/12/26, 09:01 - Messages and calls are end-to-end encrypted.",
      "1/14/26, 09:02 - Grace: hi",
    ].join("\n"),
  );
  expect(events.map((event) => event.metadata["sender"])).toEqual([
    "Ada",
    "Grace",
  ]);
  expect(events[0]?.occurred_at).toBe("2026-01-13T09:00:00.000Z");
});

test("a file with no timestamped line is refused", async () => {
  const error = await rejected(() => parse("just some prose\nand more prose"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain(
    "not a WhatsApp chat export (no timestamped line found)",
  );
});

test("the configured owner name becomes the self subject", async () => {
  const events = await parse(FIXTURE_CHAT, { self: "Ada", chat: "Launch" });
  expect(events[0]?.subjects[0]?.subject_id).toBe("whatsapp:self");
  expect(events[0]?.subjects[0]?.display_name).toBe("Ada");
  expect(events[0]?.subjects[1]?.subject_id).toBe(
    "whatsapp:chat:launch-ccf56ef5",
  );
  expect(events[1]?.subjects[0]?.subject_id).toBe("whatsapp:grace-f2465f78");
});

test("a participant cannot claim the owner's subject by their name", async () => {
  const chat = [
    "1/13/26, 09:00 - Self: hi",
    "1/13/26, 09:01 - \u202fSELF\u202f: hello",
    "1/13/26, 09:02 - Ada: hey",
  ].join("\n");
  const events = await parse(chat, { date_order: "mdy" });
  const ids = events.map((event) => event.subjects[0]?.subject_id ?? "");
  expect(ids).not.toContain("whatsapp:self");
  expect(new Set(ids).size).toBe(3);
  for (const id of ids.slice(0, 2)) {
    expect(id.startsWith("whatsapp:self-")).toBe(true);
  }
  expect(ids[2]).toBe("whatsapp:ada-99a563ab");

  // The reserved id is still the configured owner's, and only theirs.
  const owned = await parse(chat, { date_order: "mdy", self: "Self" });
  expect(owned[0]?.subjects[0]?.subject_id).toBe("whatsapp:self");
  expect(owned[1]?.subjects[0]?.subject_id).not.toBe("whatsapp:self");
});

test("the chat name comes from the export file name", () => {
  expect(chatNameFromFile(`/exports/${CHAT_FILE}`)).toBe("Acme Planning");
  expect(chatNameFromFile("/exports/Acme Planning/_chat.txt")).toBe(
    "Acme Planning",
  );
  expect(chatNameFromFile("/exports/export.txt")).toBe("export");
});
