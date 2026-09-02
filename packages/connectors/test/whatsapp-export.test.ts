import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT, MAX_RECORD_BYTES } from "../src/util";
import {
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
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

test("a message is weighed while it gathers its continuation lines", async () => {
  // A message runs until the next timestamped line, so an export with none
  // assembles the rest of the file into one record. The refusal arrives
  // before the export's dates are even resolved, which is why this export's
  // ambiguous dates never get a chance to fail first.
  const lines = [
    "1/2/26, 09:00 - Ada: one",
    "3/4/26, 09:00 - Grace: two",
    ...Array.from({ length: 24 }, () => "c".repeat(64 * 1024)),
  ];
  const error = await rejected(() => parse(lines.join("\n")));
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe(
    `line 2: message exceeds ${MAX_RECORD_BYTES} bytes`,
  );
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

test("a purge plan reaches the messages filed under one handle", async () => {
  await withTempRoot(async (root) => {
    const source = path.join(root, "export");
    await mkdir(source);
    await writeFile(
      path.join(source, CHAT_FILE),
      [
        "1/4/26, 09:00 - Ada: one",
        "1/4/26, 09:01 - Grace: two",
        "1/4/26, 09:02 - A B: three",
        "1/4/26, 09:03 - A-B: four",
        "",
      ].join("\n"),
    );
    const connector = createWhatsAppImportConnector({
      path: source,
      timezone: WHATSAPP_FIXTURE_TIMEZONE,
      date_order: "mdy",
    });
    const { events } = await connector.backfill(null);
    const id = (at: number): string => events[at]?.source_record_id ?? "";

    // The id an owner can read off a person page is the id that plans the
    // purge, and it reaches that participant's messages and no others.
    const plan = await connector.purgeSource("whatsapp:ada");
    expect(plan.unreachable_source_record_ids).toEqual([id(0)]);
    expect(plan.source_record_ids).toEqual([]);

    // Two names that shorten to one handle are one subject, so a plan aimed
    // at that handle reaches both. The README says so, and the plan is what
    // shows it before anything is deleted.
    const shared = await connector.purgeSource("whatsapp:a-b");
    expect(shared.unreachable_source_record_ids).toEqual(
      [id(2), id(3)].sort(),
    );

    // The chat is a subject of every message in it.
    const chat = await connector.purgeSource("whatsapp:chat:acme-planning");
    expect(chat.unreachable_source_record_ids.length).toBe(4);
  });
});

test("a refusal never names the chat file found inside an export", async () => {
  const canary = "canary-quartz-heron";
  await withTempRoot(async (root) => {
    const unreadable = path.join(root, "unreadable");
    await mkdir(unreadable);
    const locked = path.join(unreadable, `WhatsApp Chat with ${canary}.txt`);
    await writeFile(locked, FIXTURE_CHAT);
    await chmod(locked, 0o000);

    const garbled = path.join(root, "garbled");
    await mkdir(garbled);
    await writeFile(
      path.join(garbled, `WhatsApp Chat with ${canary}.txt`),
      Buffer.from([0x41, 0xff, 0x42]),
    );

    const messages: string[] = [];
    try {
      for (const source of [unreadable, garbled]) {
        const connector = createWhatsAppImportConnector({
          path: source,
          timezone: WHATSAPP_FIXTURE_TIMEZONE,
        });
        for (const failure of [
          () => connector.backfill(null),
          () => connector.sync(null),
          () => connector.purgeSource("whatsapp:chat:acme-planning"),
        ]) {
          const error = await rejected(failure);
          messages.push(error.message);
          // The owner's own configured path is what a refusal may name.
          expect(error.message).toContain(source);
        }
        messages.push((await connector.health()).detail ?? "");
      }
    } finally {
      await chmod(locked, 0o600);
    }
    for (const message of messages) {
      expect(message).not.toContain(canary);
    }
  });
});

test("a chat file a terminal would act on is not a chat export", async () => {
  await withTempRoot(async (root) => {
    const hostile = path.join(root, "hostile");
    await mkdir(hostile);
    await writeFile(path.join(hostile, "chat\u001b[2Kwith.txt"), FIXTURE_CHAT);
    const connector = createWhatsAppImportConnector({
      path: hostile,
      timezone: WHATSAPP_FIXTURE_TIMEZONE,
    });
    const error = await rejected(() => connector.backfill(null));
    expect(error.code).toBe("misconfigured");
    expect(error.message).toBe(
      `kizuki.import-whatsapp: no .txt chat export in ${hostile}`,
    );
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail ?? "").not.toMatch(/[\u0000-\u001f\u007f]/);
  });
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

test("an export directory that cannot be listed is refused, not thrown", async () => {
  await withTempRoot(async (root) => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const connector = createWhatsAppImportConnector({
        path: locked,
        timezone: WHATSAPP_FIXTURE_TIMEZONE,
      });
      const error = await rejected(() => connector.backfill(null));
      expect(error.code).toBe("misconfigured");
      expect(error.message).toContain("cannot read");
      const report = await connector.health();
      expect(report.state).toBe("misconfigured");
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

test("media is sized in the folder the export was listed in", async () => {
  await withTempRoot(async (root) => {
    // A media folder is named once, when the export is resolved, and read
    // afterwards. Anything with write access to a directory above it can point
    // that name at another folder in between, so the name is not what the
    // sizes come from.
    const exportDir = path.join(root, "export");
    const outside = path.join(root, "outside");
    await mkdir(exportDir);
    await mkdir(outside);
    await writeFile(path.join(exportDir, "IMG-1.jpg"), "beside the chat");
    await writeFile(path.join(outside, "IMG-1.jpg"), "somewhere else");

    const lookup = fsMediaLookup(exportDir);
    expect(await lookup("IMG-1.jpg")).toEqual({ byte_size: 15 });

    await rm(path.join(exportDir, "IMG-1.jpg"));
    await rm(exportDir, { recursive: true });
    await symlink(outside, exportDir);
    expect(await lookup("IMG-1.jpg")).toBe(null);

    // Nor from a directory moved into the export's place, which is how a file
    // the owner can read and an attacker cannot would be offered up.
    await rm(exportDir);
    await rename(outside, exportDir);
    expect(await lookup("IMG-1.jpg")).toBe(null);
  });
});
