import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvatarStore, normalizeAvatarName, parseAvatarSources } from "./avatar-store.ts";

const root = mkdtempSync(join(tmpdir(), "kz-avatars-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function source(kind: string, rows: unknown[], files: string[]): string {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "jpg");
  const index = join(dir, "index.json");
  writeFileSync(index, JSON.stringify(rows));
  return index;
}

const tgIndex = source(
  "tg",
  [
    { user_id: 101, username: "ada_l", first_name: "Ada", last_name: "Lovelace", display_name: "Ada Lovelace", has_photo: true, file: "101.jpg" },
    { user_id: 102, username: null, first_name: "Chris", last_name: null, display_name: "Chris", has_photo: true, file: "102.jpg" },
    { user_id: 103, display_name: "Sam Twin", has_photo: true, file: "103.jpg" },
    { user_id: 104, display_name: "Sam Twin", has_photo: true, file: "104.jpg" },
    { user_id: 105, display_name: "No Photo Person", has_photo: false, file: null },
    { user_id: 106, display_name: "Evil Path", has_photo: true, file: "../escape.jpg" },
  ],
  ["101.jpg", "102.jpg", "103.jpg", "104.jpg"],
);
const waIndex = source(
  "wa",
  [{ jid: "x@s.whatsapp.net", phone_user: "1", push_name: "Grace Hopper 🚢", name: null, has_photo: true, file: "1.jpg" }],
  ["1.jpg"],
);

const store = new AvatarStore(parseAvatarSources(`telegram:${tgIndex},whatsapp:${waIndex}`), 0);

describe("AvatarStore", () => {
  test("parses only absolute telegram/whatsapp sources", () => {
    expect(parseAvatarSources("telegram:/a.json,bogus:/b.json,whatsapp:rel.json")).toEqual([
      { kind: "telegram", indexPath: "/a.json" },
    ]);
    expect(new AvatarStore([]).enabled).toBe(false);
  });

  test("matches by telegram user id and handle before names", () => {
    expect(store.filePath({ key: "x", names: [], telegramUserId: "101" })).toBe(join(root, "tg", "101.jpg"));
    expect(store.filePath({ key: "x", names: [], telegramHandle: "@ADA_L" })).toBe(join(root, "tg", "101.jpg"));
  });

  test("matches full names across sources, ignoring emoji and case", () => {
    expect(normalizeAvatarName("Grace Hopper 🚢")).toBe("grace hopper");
    expect(store.filePath({ key: "g", names: ["grace hopper"] })).toBe(join(root, "wa", "1.jpg"));
  });

  test("never guesses: single-token, ambiguous, photo-less and unsafe entries are skipped", () => {
    expect(store.has({ key: "c", names: ["Chris"] })).toBe(false);
    expect(store.has({ key: "s", names: ["Sam Twin"] })).toBe(false);
    expect(store.has({ key: "n", names: ["No Photo Person"] })).toBe(false);
    expect(store.has({ key: "e", names: ["Evil Path"] })).toBe(false);
  });
});

describe("AvatarStore one-word and annotated names", () => {
  const tg2 = source(
    "tg2",
    [
      { user_id: 201, display_name: "Zac", first_name: "Zac", has_photo: true, file: "201.jpg" },
      { user_id: 202, display_name: "Mladen Kostov met at expo", has_photo: true, file: "202.jpg" },
    ],
    ["201.jpg", "202.jpg"],
  );
  const wa2 = source("wa2", [{ jid: "z@s.whatsapp.net", push_name: "Zac", has_photo: true, file: "9.jpg" }], ["9.jpg"]);
  const solo = new AvatarStore(parseAvatarSources(`telegram:${tg2}`), 0);
  const both = new AvatarStore(parseAvatarSources(`telegram:${tg2},whatsapp:${wa2}`), 0);

  test("one-word name needs the matching channel and a unique photo", () => {
    expect(solo.has({ key: "z", names: ["Zac"], channels: ["telegram"] })).toBe(true);
    expect(solo.has({ key: "z", names: ["Zac"], channels: ["whatsapp"] })).toBe(false);
    expect(solo.has({ key: "z", names: ["Zachary Long", "Zac"], channels: ["telegram"] })).toBe(false);
    expect(both.has({ key: "z", names: ["Zac"], channels: ["telegram", "whatsapp"] })).toBe(false);
  });

  test("annotated contact names match on their leading full name", () => {
    expect(solo.has({ key: "m", names: ["Mladen Kostov"] })).toBe(true);
  });
});

describe("AvatarStore cross-source safety", () => {
  test("a full name with different photos in two sources is skipped unless channels settle it", () => {
    const t = source("tg3", [{ user_id: 301, display_name: "Pat Smith", has_photo: true, file: "301.jpg" }], ["301.jpg"]);
    const w = source("wa3", [{ jid: "p@s.whatsapp.net", push_name: "Pat Smith", has_photo: true, file: "7.jpg" }], ["7.jpg"]);
    const s = new AvatarStore(parseAvatarSources(`telegram:${t},whatsapp:${w}`), 0);
    expect(s.has({ key: "p", names: ["Pat Smith"] })).toBe(false);
    expect(s.has({ key: "p", names: ["Pat Smith"], channels: ["telegram", "whatsapp"] })).toBe(false);
    expect(s.filePath({ key: "p", names: ["Pat Smith"], channels: ["whatsapp"] })).toBe(join(root, "wa3", "7.jpg"));
  });

  test("a symlinked photo pointing outside its directory is refused", () => {
    const { symlinkSync } = require("node:fs");
    const outside = join(root, "outside.jpg");
    writeFileSync(outside, "secret");
    const dir = join(root, "tg4");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "401.jpg"));
    writeFileSync(join(dir, "index.json"), JSON.stringify([{ user_id: 401, display_name: "Link Person", has_photo: true, file: "401.jpg" }]));
    const s = new AvatarStore(parseAvatarSources(`telegram:${join(dir, "index.json")}`), 0);
    expect(s.filePath({ key: "l", names: [], telegramUserId: "401" })).toBeNull();
  });
});
