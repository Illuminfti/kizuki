import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateEventInput, type CaptureEventInput } from "@kizuki/core";
import {
  MAX_PART_BYTES,
  X_ARCHIVE_CONNECTOR_ID,
  XArchiveConnector,
  mapPost,
  parseCursor,
  parseYtd,
} from "@kizuki/connector-x";

const OBSERVED = "2026-06-01T15:00:00.000Z";
const ACCOUNT_ID = "123456789012345678";
const ACCOUNT =
  `window.YTD.account.part0 = [{"account":{"accountId":"${ACCOUNT_ID}","username":"fixture_owner"}}];`;
const SELF = { account_id: ACCOUNT_ID, username: "fixture_owner" } as const;
const CORE_STAMPS = [
  "event_id",
  "content_hash",
  "content_hash_version",
  "text_hash",
  "origin",
  "origin_binding_version",
  "origin_binding_kind",
  "origin_binding",
] as const;

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function tweet(fields: Record<string, unknown>) {
  return {
    tweet: {
      id_str: "1742012345678901234",
      created_at: "Tue Jan 02 03:04:05 +0000 2024",
      full_text: "short",
      lang: "en",
      entities: { urls: [], user_mentions: [] },
      ...fields,
    },
  };
}

function ytdTweets(records: unknown[], part = 0, bom = false): string {
  return `${bom ? "\uFEFF" : ""}window.YTD.tweets.part${part} = ${JSON.stringify(records, null, 2)};`;
}

function assertIngress(event: CaptureEventInput): void {
  expect(validateEventInput(event).ok).toBe(true);
  for (const key of CORE_STAMPS) expect(key in event).toBe(false);
}

async function writeArchive(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-x-fid-"));
  roots.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

function connector(root: string): XArchiveConnector {
  return new XArchiveConnector({ path: root }, { now: () => new Date(OBSERVED) });
}

describe("X archive import source fidelity", () => {
  test("the YTD wrapper yields JSON and refuses surrounding JavaScript", () => {
    const records = [tweet({ full_text: "合成 cafe\u0301" })];
    const extracted = parseYtd(ytdTweets(records, 0, true), "tweets", 0);
    expect(extracted).toEqual(records);
    expect(mapPost(extracted[0]!, 0, 0, SELF, new Map(), OBSERVED).event.text)
      .toBe("合成 cafe\u0301");

    expect(() => parseYtd(
      'globalThis.pwned=true; window.YTD.tweets.part0 = [];',
      "tweets",
      0,
    )).toThrow("invalid archive wrapper");
    expect(() => parseYtd(
      'window.YTD.tweet.part0 = [];',
      "tweets",
      0,
    )).toThrow("invalid archive wrapper");
  });

  test("a synthetic archive keeps long Unicode owner text, quote/reply ids, and file attachment descriptors", async () => {
    const long = "A longer synthetic owner post. ".repeat(40).trim();
    const unicode = "合成 cafe\u0301 🐦 العربية";
    const root = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": ytdTweets([
        tweet({
          full_text: "short preview",
          truncated: true,
          display_text_range: [0, 5],
          in_reply_to_status_id_str: "1742012345678901200",
          in_reply_to_user_id_str: "777",
          quoted_status_id_str: "1742012345678901300",
          quoted_status: {
            id_str: "1742012345678901300",
            full_text: "FOREIGN_QUOTED_TEXT_MUST_NOT_IMPORT",
          },
          note_tweet: { text: `${long} ${unicode}` },
        }),
        tweet({
          id_str: "1742012345678901235",
          created_at: "Tue Jan 02 08:34:05 +0530 2024",
          full_text: "attachment post",
          entities: {
            urls: [{ expanded_url: "https://example.test/media.jpg" }],
            user_mentions: [],
            media: [{ media_url_https: "https://example.test/media.jpg", type: "photo" }],
          },
        }),
      ], 0, true),
      "data/tweets_media/1742012345678901235-clip.xyz": "x",
      "data/tweets_media/1742012345678901235-photo.jpg": "jpeg-bytes",
      "data/tweets_media/1742012345678909999-other.jpg": "no",
    });

    const batch = await connector(root).backfill(null);
    expect(batch.events).toHaveLength(2);
    for (const event of batch.events) {
      expect(event.connector_id).toBe(X_ARCHIVE_CONNECTOR_ID);
      expect(event.kind).toBe("post");
      assertIngress(event);
    }

    const owner = batch.events[0]!;
    expect(owner.source_record_id).toBe("post:1742012345678901234");
    expect(owner.text).toBe(`${long} ${unicode}`);
    expect(owner.text).not.toContain("FOREIGN_QUOTED_TEXT_MUST_NOT_IMPORT");
    expect(owner.text).not.toBe("short preview");
    expect(owner.occurred_at).toBe("2024-01-02T03:04:05.000Z");
    expect(owner.observed_at).toBe(OBSERVED);
    expect(owner.metadata).toMatchObject({
      in_reply_to_post_id: "1742012345678901200",
      in_reply_to_user_id: "777",
      quoted_status_id: "1742012345678901300",
    });
    expect(owner.subjects).toEqual([
      { subject_id: `x:user:${ACCOUNT_ID}`, role: "from", display_name: "@fixture_owner" },
      { subject_id: "x:user:777", role: "to" },
    ]);
    expect(owner.attachments).toEqual([]);

    const attached = batch.events[1]!;
    expect(attached.source_record_id).toBe("post:1742012345678901235");
    expect(attached.text).toBe("attachment post");
    expect(attached.occurred_at).toBe("2024-01-02T03:04:05.000Z");
    expect(attached.metadata.urls).toEqual(["https://example.test/media.jpg"]);
    expect(attached.attachments).toEqual([
      {
        attachment_id: "1742012345678901235-clip.xyz",
        media_type: "application/octet-stream",
        filename: "1742012345678901235-clip.xyz",
        byte_size: 1,
      },
      {
        attachment_id: "1742012345678901235-photo.jpg",
        media_type: "image/jpeg",
        filename: "1742012345678901235-photo.jpg",
        byte_size: 10,
      },
    ]);
  });

  test("malformed wrappers, oversized parts, duplicate ids, and resume keep the last durable cursor", async () => {
    const secret = "private-archive-token";
    const malformed = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": `window.YTD.tweets.part0 = [${secret}];`,
    });
    try {
      await connector(malformed).backfill(null);
      throw new Error("expected refusal");
    } catch (error) {
      expect(String(error)).toContain("malformed JSON");
      expect(String(error)).not.toContain(secret);
    }

    const invalidDate = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": ytdTweets([tweet({
        full_text: "synthetic invalid date",
        created_at: "Tue Feb 30 03:04:05 +0000 2024",
      })]),
    });
    await expect(connector(invalidDate).backfill(null))
      .rejects.toMatchObject({ code: "parse_error" });

    const oversized = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": ytdTweets([tweet({})]),
    });
    await truncate(path.join(oversized, "data", "tweets.js"), MAX_PART_BYTES + 1);
    await expect(connector(oversized).backfill(null)).rejects.toThrow("exceeds");

    const duplicate = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": ytdTweets([tweet({ full_text: "first" })]),
      "data/tweets-part1.js": ytdTweets([tweet({ full_text: "same id later" })], 1),
    });
    await expect(connector(duplicate).backfill(null))
      .rejects.toMatchObject({ code: "parse_error" });

    const resumable = await writeArchive({
      "data/account.js": ACCOUNT,
      "data/tweets.js": ytdTweets([tweet({ full_text: "part zero" })]),
      "data/tweets-part1.js": ytdTweets([tweet({
        id_str: "1742012345678901236",
        full_text: "part one",
      })], 1),
    });
    const first = await connector(resumable).backfill(null);
    expect(first.events.map((event) => event.text)).toEqual(["part zero"]);
    expect(parseCursor(first.cursor!)).toMatchObject({
      next_part: 1, next_record: 0, seen_records: 1,
    });
    const second = await connector(resumable).backfill(first.cursor);
    expect(second.events.map((event) => event.text)).toEqual(["part one"]);
    expect(parseCursor(second.cursor!)).toMatchObject({
      next_part: null, next_record: null, seen_records: 2,
    });
    const again = await connector(resumable).backfill(second.cursor);
    expect(again.events).toEqual([]);
    expect(again.cursor).toBe(second.cursor);
  });
});
