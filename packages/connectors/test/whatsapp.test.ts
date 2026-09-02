import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import {
  FIXTURE_OBSERVED_AT,
  MAX_RECORD_BYTES,
  readBoundedUtf8,
} from "../src/util";
import {
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  chatNameFromFile,
  createWhatsAppImportConnector,
  fsMediaLookup,
  mapMediaLookup,
  parseWhatsAppExport,
} from "../src/import-whatsapp";
import type {
  MediaLookup,
  WhatsAppImportConfig,
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
  expect(events[0]?.subjects).toEqual([
    { subject_id: "whatsapp:ada", role: "from", display_name: "Ada" },
    {
      subject_id: "whatsapp:chat:acme-planning",
      role: "about",
      display_name: "Acme Planning",
    },
  ]);
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
  expect(events[0]?.subjects[1]?.subject_id).toBe("whatsapp:chat:launch");
  expect(events[1]?.subjects[0]?.subject_id).toBe("whatsapp:grace");
});

test("the chat name comes from the export file name", () => {
  expect(chatNameFromFile(`/exports/${CHAT_FILE}`)).toBe("Acme Planning");
  expect(chatNameFromFile("/exports/Acme Planning/_chat.txt")).toBe(
    "Acme Planning",
  );
  expect(chatNameFromFile("/exports/export.txt")).toBe("export");
});

test("an unsafe or absent media name yields no attachment and no error", async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, "real.jpg"), "0123456789");
    await symlink(path.join(root, "real.jpg"), path.join(root, "link.jpg"));
    const events = await parse(
      [
        "4/1/26, 09:00 - Ada: ../../etc/passwd (file attached)",
        "4/1/26, 09:01 - Ada: a/b.jpg (file attached)",
        "4/1/26, 09:02 - Ada: -rf.jpg (file attached)",
        "4/1/26, 09:03 - Ada: link.jpg (file attached)",
        "4/1/26, 09:04 - Ada: missing.jpg (file attached)",
        "4/1/26, 09:05 - Ada: real.jpg (file attached)",
      ].join("\n"),
      { date_order: "dmy", media: fsMediaLookup(root) },
    );
    expect(events.map((event) => event.attachments.length)).toEqual([
      0, 0, 0, 0, 0, 1,
    ]);
    expect(events[5]?.attachments[0]?.byte_size).toBe(10);
  });
});

test("an attachment size comes from the lookup, never from the bytes", async () => {
  const asked: string[] = [];
  const lookup: MediaLookup = async (filename) => {
    asked.push(filename);
    return { byte_size: 4242 };
  };
  const events = await parse("4/1/26, 09:00 - Ada: real.jpg (file attached)", {
    date_order: "dmy",
    media: lookup,
  });
  expect(asked).toEqual(["real.jpg"]);
  expect(events[0]?.attachments[0]?.byte_size).toBe(4242);
});

test("an export directory resolves to its single chat file", async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, CHAT_FILE), FIXTURE_CHAT);
    await writeFile(path.join(root, "IMG-20260104-WA0001.jpg"), "x".repeat(26));
    const connector = createWhatsAppImportConnector({
      path: root,
      timezone: WHATSAPP_FIXTURE_TIMEZONE,
    });
    const batch = await connector.backfill(null);
    expect(batch.cursor).toBeNull();
    expect(batch.events.length).toBe(8);
    expect((await connector.health()).state).toBe("ok");
  });
});

test("a directory with no chat file or several is refused", async () => {
  await withTempRoot(async (root) => {
    const empty = path.join(root, "empty");
    const several = path.join(root, "several");
    await mkdir(empty);
    await mkdir(several);
    await writeFile(path.join(several, "one.txt"), FIXTURE_CHAT);
    await writeFile(path.join(several, "two.txt"), FIXTURE_CHAT);

    const none = createWhatsAppImportConnector({ path: empty });
    const many = createWhatsAppImportConnector({ path: several });
    expect((await rejected(() => none.backfill(null))).message).toContain(
      "no .txt chat export in",
    );
    expect((await rejected(() => many.backfill(null))).message).toContain(
      "several .txt files in",
    );
    expect((await none.health()).state).toBe("misconfigured");
    expect((await many.health()).state).toBe("misconfigured");
  });
});

test("a zip and a symlinked chat file are refused", async () => {
  await withTempRoot(async (root) => {
    const real = path.join(root, CHAT_FILE);
    const link = path.join(root, "link.txt");
    await writeFile(real, FIXTURE_CHAT);
    await symlink(real, link);
    const zipped = createWhatsAppImportConnector({
      path: path.join(root, "export.zip"),
    });
    await writeFile(path.join(root, "export.zip"), "PK");
    const linked = createWhatsAppImportConnector({ path: link });
    expect((await rejected(() => zipped.backfill(null))).message).toContain(
      "unzip the export first",
    );
    expect((await rejected(() => linked.backfill(null))).code).toBe(
      "misconfigured",
    );
    expect((await linked.health()).state).toBe("misconfigured");
  });
});

test("health reports a missing path instead of throwing", async () => {
  const report = await createWhatsAppImportConnector({
    path: "/nonexistent/chat",
  }).health();
  expect(report.state).toBe("misconfigured");
  expect(report.detail).toContain("/nonexistent/chat");
});

test("a message beyond the per-record bound names its line", async () => {
  const huge = "x".repeat(MAX_RECORD_BYTES + 1);
  const error = await rejected(() =>
    parse(`4/1/26, 09:00 - Ada: ${huge}`, { date_order: "dmy" }),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("line 1");
});

test("a sender name beyond the per-record bound names its line", async () => {
  const huge = "S".repeat(MAX_RECORD_BYTES + 1);
  const error = await rejected(() =>
    parse(`4/1/26, 09:00 - ${huge}: hi`, { date_order: "dmy" }),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("line 1");
  expect(error.message).toContain("sender");
});

test("no refusal quotes a sender name or captured text", async () => {
  const canary = "canary-quartz-heron";
  const messages: string[] = [];
  await withTempRoot(async (root) => {
    const several = path.join(root, "several");
    await mkdir(several);
    await writeFile(path.join(several, `one ${canary}.txt`), "");
    await writeFile(path.join(several, `two ${canary}.txt`), "");
    const bounded = `4/1/26, 09:00 - Ada ${canary}: ${"x".repeat(
      MAX_RECORD_BYTES + 1,
    )}`;
    const failures: (() => Promise<unknown>)[] = [
      () => parse(`Ada ${canary}: hello`),
      () => parse(bounded, { date_order: "dmy" }),
      () =>
        parse(`31/04/2026, 09:00 - Ada ${canary}: hi`, { date_order: "dmy" }),
      () =>
        parse(
          [
            `1/2/26, 09:00 - Ada ${canary}: hi`,
            `3/4/26, 09:00 - Ada ${canary}: ho`,
          ].join("\n"),
        ),
    ];
    for (const failure of failures) {
      messages.push((await rejected(failure)).message);
    }
    const report = await createWhatsAppImportConnector({
      path: several,
    }).health();
    messages.push(report.detail ?? "");
  });
  for (const message of messages) {
    expect(message).not.toContain(canary);
    expect(message).not.toContain("Ada");
  }
});

test("a malformed config fails construction", () => {
  const construct = (config: unknown): void => {
    // The registry hands connectors whatever the host wrote; the constructor
    // is the boundary that has to prove it.
    createWhatsAppImportConnector(config as WhatsAppImportConfig);
  };
  expect(() =>
    construct({ path: "/x", timezone: "+02:00", chat: "Acme Planning" }),
  ).not.toThrow();
  for (const config of [
    {},
    { path: "/x", tz: "+02:00" },
    { path: "/x", timezone: "Not/AZone" },
    { path: "/x", date_order: "xyz" },
    { path: "/x", self: "" },
  ]) {
    try {
      construct(config);
      throw new Error("expected construction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(KizukiError);
      if (error instanceof KizukiError) {
        expect(error.code).toBe("misconfigured");
      }
    }
  }
});
