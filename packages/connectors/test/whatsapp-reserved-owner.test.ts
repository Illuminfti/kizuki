import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accept, initVault, readSince, runPurge } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  mapMediaLookup,
  parseWhatsAppExport,
} from "../src/import-whatsapp";

const CHAT = [
  "13.01.2026, 18:05 - Ada: owner-line",
  "13.01.2026, 18:06 - self: other-line",
  "13.01.2026, 18:07 - Self!: also-other",
  "13.01.2026, 18:08 - Grace: stay",
].join("\n");

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

function participantId(name: string): string {
  return `whatsapp:participant:${new Bun.CryptoHasher("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 16)}`;
}

test("a slug that folds to self does not mint the reserved owner id", async () => {
  const fromSelf = participantId("self");
  const fromSelfBang = participantId("Self!");
  expect(fromSelf).not.toBe(fromSelfBang);
  expect(fromSelf.startsWith("whatsapp:participant:")).toBe(true);
  expect(fromSelfBang.startsWith("whatsapp:participant:")).toBe(true);

  const owned = await parse(CHAT, { self: "Ada" });
  const unowned = await parse(CHAT);

  expect(owned.map((event) => event.subjects[0]?.display_name)).toEqual([
    "Ada",
    "self",
    "Self!",
    "Grace",
  ]);
  expect(owned.map((event) => event.subjects[0]?.subject_id)).toEqual([
    "whatsapp:self",
    fromSelf,
    fromSelfBang,
    "whatsapp:grace",
  ]);
  expect(unowned.map((event) => event.subjects[0]?.subject_id)).toEqual([
    "whatsapp:ada",
    fromSelf,
    fromSelfBang,
    "whatsapp:grace",
  ]);
  expect(
    unowned.some((event) => event.subjects[0]?.subject_id === "whatsapp:self"),
  ).toBe(false);
  expect(owned.map((event) => event.source_record_id)).toEqual(
    unowned.map((event) => event.source_record_id),
  );
});

test("owner purge by whatsapp:self leaves non-owner self participants", async () => {
  const owned = await parse(CHAT, { self: "Ada" });
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-whatsapp-owner-"));
  const vault = path.join(root, "vault");
  const db = openLedger(":memory:");
  try {
    initVault(vault);
    for (const event of owned) {
      expect(accept(db, event).status).toBe("stored");
    }
    await runPurge(
      db,
      vault,
      {
        connector_id: WHATSAPP_IMPORT_CONNECTOR_ID,
        subject_handle: "whatsapp:self",
      },
      "owner subject",
    );
    expect(readSince(db, null, 10).events.map((event) => event.text)).toEqual([
      "other-line",
      "also-other",
      "stay",
    ]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
