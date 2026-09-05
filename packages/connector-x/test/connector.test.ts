import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KizukiError } from "@kizuki/core";
import { InMemoryLedger } from "../../connectors/src/ledger";
import {
  MAX_PART_BYTES,
  X_ARCHIVE_CONNECTOR_ID,
  XArchiveConnector,
  parseCursor,
  scanArchive,
} from "../src";
import {
  FIXTURE_ACCOUNT_SOURCE,
  FIXTURE_TWEETS_SOURCE,
  writeFixtureArchive,
} from "../src/testkit";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryArchive(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-x-"));
  roots.push(root);
  await writeFixtureArchive(root);
  return root;
}

function tweet(id: string, text = `post ${id}`, created = "Tue Jan 02 03:04:05 +0000 2024") {
  return { tweet: { id_str: id, created_at: created, full_text: text, entities: { urls: [], user_mentions: [] } } };
}

function tweetsSource(part: number, records: unknown[]): string {
  return `window.YTD.tweets.part${part} = ${JSON.stringify(records)};`;
}

describe("local X archive connector", () => {
  test("imports posts with native provenance and candid bounded coverage", async () => {
    const root = await temporaryArchive();
    const media = path.join(root, "data", "tweets_media");
    await mkdir(media);
    await writeFile(path.join(media, "1742012345678901234-photo.jpg"), "bytes");
    await writeFile(path.join(root, "data", "like.js"), "window.YTD.like.part0 = [];");
    const connector = new XArchiveConnector({ path: root }, { now: () => new Date("2026-01-01T00:00:00Z") });

    const health = await connector.health();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("likes=not_inspected");
    expect(health.detail).toContain("direct_messages=not_supported");
    expect(health.detail).toContain("media_bytes=not_supported");
    expect(health.detail!.length).toBeLessThanOrEqual(256);
    const first = await connector.backfill(null);
    expect(first.events).toHaveLength(2);
    expect(first.events[0]).toMatchObject({
      connector_id: X_ARCHIVE_CONNECTOR_ID,
      source_record_id: "post:1742012345678901234",
      occurred_at: "2024-01-02T03:04:05.000Z",
      observed_at: "2026-01-01T00:00:00.000Z",
      sensitivity_hint: "personal",
      deleted: false,
    });
    expect(first.events[0]?.subjects[0]).toMatchObject({
      subject_id: "x:user:123456789012345678", role: "from",
    });
    expect(first.events[0]?.attachments[0]).toMatchObject({
      attachment_id: "1742012345678901234-photo.jpg", byte_size: 5,
    });
    expect(first.events[0]?.metadata).toMatchObject({
      source: "x_archive",
      account_id: "123456789012345678",
      post_id: "1742012345678901234",
    });
    expect(first.cursor).not.toBeNull();
    expect(parseCursor(first.cursor!)).toMatchObject({ next_part: null, next_record: null, seen_records: 2 });
    expect(await connector.backfill(first.cursor)).toEqual({ events: [], cursor: first.cursor });
    await expect(connector.purgeSource("x:user:123")).rejects.toMatchObject({ code: "not_supported" });
  });

  test("resets a changed same-account snapshot and never infers deletions", async () => {
    const root = await temporaryArchive();
    const connector = new XArchiveConnector({ path: root });
    const complete = await connector.backfill(null);
    await writeFile(path.join(root, "data", "tweets.js"), tweetsSource(0, [tweet("1742012345678901234", "edited")]));
    const changed = await connector.sync(complete.cursor);
    expect(changed.events.map((event) => [event.source_record_id, event.text, event.deleted]))
      .toEqual([["post:1742012345678901234", "edited", false]]);
    expect(parseCursor(changed.cursor!)).toMatchObject({ next_part: null, seen_records: 1 });
  });

  test("pages at 500 records and preserves stable native identities after restart", async () => {
    const root = await temporaryArchive();
    const records = Array.from({ length: 501 }, (_, index) =>
      tweet(String(1742012345678902000n + BigInt(index))));
    await writeFile(path.join(root, "data", "tweets.js"), tweetsSource(0, records));
    const first = await new XArchiveConnector({ path: root }).backfill(null);
    const replay = await new XArchiveConnector({ path: root }).backfill(null);
    expect(first.events).toHaveLength(500);
    expect(first.events.map((event) => event.source_record_id))
      .toEqual(replay.events.map((event) => event.source_record_id));
    expect(first.events.map((event) => event.occurred_at))
      .toEqual(replay.events.map((event) => event.occurred_at));
    expect(first.cursor).toBe(replay.cursor);
    expect(parseCursor(first.cursor!)).toMatchObject({ next_part: 0, next_record: 500, seen_records: 500 });
    const final = await new XArchiveConnector({ path: root }).backfill(first.cursor);
    expect(final.events).toHaveLength(1);
    expect(parseCursor(final.cursor!)).toMatchObject({ next_part: null, seen_records: 501 });
  });

  test("restart replay dedupes while an edited native post stores a new version", async () => {
    const root = await temporaryArchive();
    const ledger = new InMemoryLedger();
    const first = await new XArchiveConnector(
      { path: root },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    ).backfill(null);
    expect(ledger.acceptMany(first.events).map((result) => result.status))
      .toEqual(["stored", "stored"]);
    const replay = await new XArchiveConnector(
      { path: root },
      { now: () => new Date("2026-02-01T00:00:00.000Z") },
    ).backfill(null);
    expect(ledger.acceptMany(replay.events).map((result) => result.status))
      .toEqual(["duplicate", "duplicate"]);

    await writeFile(
      path.join(root, "data", "tweets.js"),
      FIXTURE_TWEETS_SOURCE.replace("A synthetic archive post with a link.", "edited owner post"),
    );
    const edited = await new XArchiveConnector({ path: root }).backfill(first.cursor);
    expect(ledger.acceptMany(edited.events).map((result) => result.status))
      .toEqual(["stored", "duplicate"]);
  });

  test("refuses malformed supported records without returning an advanced checkpoint", async () => {
    const root = await temporaryArchive();
    await writeFile(path.join(root, "data", "tweets-part1.js"), tweetsSource(1, [tweet("1742012345678901236")]));
    const connector = new XArchiveConnector({ path: root });
    const page0 = await connector.backfill(null);
    expect(parseCursor(page0.cursor!)).toMatchObject({ next_part: 1, next_record: 0, seen_records: 2 });
    await writeFile(
      path.join(root, "data", "tweets-part1.js"),
      tweetsSource(1, [tweet("1742012345678901236", "bad", "Tue Feb 30 03:04:05 +0000 2024")]),
    );
    // The changed snapshot is rejected during its bounded scan. No replacement
    // checkpoint is returned, so the caller retains the last durable cursor.
    await expect(connector.backfill(page0.cursor)).rejects.toMatchObject({ code: "parse_error" });
    expect(parseCursor(page0.cursor!)).toMatchObject({ next_part: 1, next_record: 0, seen_records: 2 });
  });

  test("health and connect validate every supported post before reporting ready", async () => {
    const root = await temporaryArchive();
    await writeFile(
      path.join(root, "data", "tweets.js"),
      tweetsSource(0, [tweet("1742012345678901234", "synthetic invalid date", "Tue Feb 30 03:04:05 +0000 2024")]),
    );
    const connector = new XArchiveConnector({ path: root });
    const health = await connector.health();
    expect(health).toMatchObject({ state: "misconfigured", detail: "kizuki.import-x-archive: post created_at is missing or invalid" });
    await expect(connector.connect(async () => "unused"))
      .rejects.toMatchObject({ code: "parse_error" });
    await expect(scanArchive(root)).rejects.toMatchObject({ code: "parse_error" });
  });

  test("rejects another account rather than applying its cursor", async () => {
    const firstRoot = await temporaryArchive();
    const cursor = (await new XArchiveConnector({ path: firstRoot }).backfill(null)).cursor;
    const secondRoot = await temporaryArchive();
    await writeFile(path.join(secondRoot, "data", "account.js"),
      'window.YTD.account.part0 = [{"account":{"accountId":"999","username":"other"}}];');
    await expect(new XArchiveConnector({ path: secondRoot }).backfill(cursor))
      .rejects.toMatchObject({ code: "misconfigured" });
  });

  test("refuses ZIP roots, symlinked inputs, noncontiguous parts, and oversize parts", async () => {
    const zipRoot = await mkdtemp(path.join(os.tmpdir(), "kizuki-x-zip-"));
    roots.push(zipRoot);
    const zip = path.join(zipRoot, "archive.zip");
    await writeFile(zip, "PK");
    await expect(scanArchive(zip)).rejects.toMatchObject({ code: "not_supported" });

    const linkedRoot = await temporaryArchive();
    await rm(path.join(linkedRoot, "data", "account.js"));
    await symlink(path.join(linkedRoot, "data", "tweets.js"), path.join(linkedRoot, "data", "account.js"));
    await expect(scanArchive(linkedRoot)).rejects.toMatchObject({ code: "misconfigured" });

    const ancestorParent = await mkdtemp(path.join(os.tmpdir(), "kizuki-x-parent-"));
    roots.push(ancestorParent);
    const nested = path.join(ancestorParent, "archive");
    await writeFixtureArchive(nested);
    const ancestorLink = `${ancestorParent}-link`;
    roots.push(ancestorLink);
    await symlink(ancestorParent, ancestorLink);
    await expect(scanArchive(path.join(ancestorLink, "archive")))
      .rejects.toThrow("symlink component");

    const mediaRoot = await temporaryArchive();
    const mediaDirectory = path.join(mediaRoot, "data", "tweets_media");
    await mkdir(mediaDirectory);
    await symlink("../tweets.js", path.join(mediaDirectory, "1742012345678901234-photo.jpg"));
    await expect(scanArchive(mediaRoot)).rejects.toMatchObject({ code: "misconfigured" });

    const gapRoot = await temporaryArchive();
    await writeFile(path.join(gapRoot, "data", "tweets-part2.js"), tweetsSource(2, [tweet("1742012345678901236")]));
    await expect(scanArchive(gapRoot)).rejects.toThrow("not contiguous");

    const largeRoot = await temporaryArchive();
    await truncate(path.join(largeRoot, "data", "tweets.js"), MAX_PART_BYTES + 1);
    await expect(scanArchive(largeRoot)).rejects.toThrow("exceeds");
  });

  test("fixture is offline and production input sources remain synthetic", async () => {
    const events = await new XArchiveConnector({ path: "/not-used-by-fixture" }).fixture();
    expect(events).toHaveLength(2);
    expect(FIXTURE_ACCOUNT_SOURCE).not.toContain("@example.com");
    expect(FIXTURE_TWEETS_SOURCE).toContain("synthetic archive post");
  });
});

test("archive failures are typed and do not expose file contents", async () => {
  const root = await temporaryArchive();
  await writeFile(path.join(root, "data", "tweets.js"), "private archive contents and token");
  try {
    await scanArchive(root);
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(KizukiError);
    expect(String(error)).not.toContain("private archive contents");
    expect(String(error)).not.toContain("token");
  }
});

test("private account fields never enter events, cursors, or health", async () => {
  const root = await temporaryArchive();
  const sentinel = "owner-secret@example.invalid";
  await writeFile(path.join(root, "data", "account.js"),
    `window.YTD.account.part0 = [{"account":{"accountId":"123456789012345678","username":"fixture_owner","email":"${sentinel}"}}];`);
  const connector = new XArchiveConnector({ path: root }, { now: () => new Date("2026-01-01T00:00:00Z") });
  const health = await connector.health();
  const batch = await connector.backfill(null);
  expect(JSON.stringify({ health, batch })).not.toContain(sentinel);
});
