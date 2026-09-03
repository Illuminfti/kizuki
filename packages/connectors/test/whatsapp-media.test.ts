import { expect, test } from "bun:test";
import {
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
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  WHATSAPP_FIXTURE_TIMEZONE,
  fsMediaLookup,
  mapMediaLookup,
  parseWhatsAppExport,
} from "../src/import-whatsapp";
import type { MediaLookup } from "../src/import-whatsapp";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-media-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
