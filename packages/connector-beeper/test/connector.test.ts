import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import { BEEPER_CONNECTOR_ID, BeeperConnector } from "../src";
import type { BeeperFetch } from "../src";
import { runConformance } from "../../connectors/src/testkit";

const TOKEN = "synthetic-token-not-a-secret";
const first = { id: "m1", accountID: "a1", chatID: "c1", senderID: "u1", sortKey: "001", timestamp: "2026-01-02T03:04:05Z", text: "hello" };
const deleted = { id: "m2", accountID: "a1", chatID: "c1", senderID: "u2", sortKey: "002", timestamp: "2026-01-02T03:05:05Z", text: "must not survive", isDeleted: true };

function reply(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function connector(fetcher: BeeperFetch): BeeperConnector { return new BeeperConnector({ token_secret_ref: "env:BEEPER_TOKEN" }, { fetch: fetcher, now: () => new Date("2026-01-03T00:00:00Z") }); }
async function connected(fetcher: BeeperFetch): Promise<BeeperConnector> { const value = connector(fetcher); await value.connect(async (ref) => { expect(ref).toBe("env:BEEPER_TOKEN"); return TOKEN; }); return value; }

test("reads the local search API, paginates backward, and uses stable source identity", async () => {
  const seen: URL[] = [];
  const value = await connected(async (input, init) => {
    const url = new URL(input.toString()); seen.push(url);
    expect(url.searchParams.get("excludeLowPriority")).toBe("false");
    expect(url.searchParams.get("includeMuted")).toBe("true");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    return url.searchParams.get("cursor") === null
      ? reply({ items: [first], hasMore: true, oldestCursor: "older" })
      : reply({ items: [deleted], hasMore: false });
  });
  const one = await value.backfill(null);
  expect(one.has_more).toBe(true);
  expect(one.events[0]?.source_record_id).toBe('["a1","c1","m1"]');
  expect(one.events[0]?.metadata).toEqual({ source_kind: "beeper", account_id: "a1", chat_id: "c1", message_id: "m1", sender_id: "u1", sort_key: "001", edited_timestamp: null });
  const two = await value.backfill(one.cursor);
  expect(two.has_more).toBe(false);
  expect(two.cursor).toBeNull();
  expect(two.events[0]).toMatchObject({ deleted: true, text: "" });
  expect(seen.map((url) => [url.pathname, url.searchParams.get("direction"), url.searchParams.get("limit"), url.searchParams.get("cursor")])).toEqual([["/v1/messages/search", "before", "20", null], ["/v1/messages/search", "before", "20", "older"]]);
});

test("does not infer tombstones from records absent from a later page", async () => {
  const value = await connected(async () => reply({ items: [first], hasMore: false }));
  const batch = await value.sync(null);
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]?.deleted).toBeFalse();
});

test("maps attachment or system messages with optional text and sender without fabricating either", async () => {
  const value = await connected(async () => reply({
    items: [{ id: "attachment", accountID: "a1", chatID: "c1", sortKey: "003", timestamp: "2026-01-02T03:06:05Z" }],
    hasMore: false,
  }));
  const batch = await value.backfill(null);
  expect(batch.events[0]).toMatchObject({ text: "", subjects: [{ subject_id: 'beeper:chat:["a1","c1"]', role: "about" }] });
  expect(batch.events[0]?.metadata).toMatchObject({ sender_id: null });
});

test("preserves safe attachment references without downloading or storing provider URLs", async () => {
  const value = await connected(async () => reply({
    items: [{
      id: "attachment", accountID: "a1", chatID: "c1", sortKey: "003", timestamp: "2026-01-02T03:06:05Z",
      attachments: [
        { type: "img", id: "mxc://beeper/media", fileName: "photo.png", fileSize: 12, mimeType: "image/png", srcURL: "https://signed.invalid/download?token=private", posterImg: "/private/preview" },
        { type: "audio", fileName: "voice.ogg", mimeType: "audio/ogg" },
      ],
    }], hasMore: false,
  }));
  const event = (await value.backfill(null)).events[0]!;
  expect(event.text).toBe("");
  expect(event.attachments).toEqual([
    { attachment_id: "mxc://beeper/media", media_type: "image/png", filename: "photo.png", byte_size: 12 },
    { attachment_id: 'beeper:attachment:["a1","c1","attachment",1]', media_type: "audio/ogg", filename: "voice.ogg" },
  ]);
  expect(JSON.stringify(event)).not.toContain("signed.invalid");
  expect(JSON.stringify(event)).not.toContain("/private/preview");
});

test("preserves a native attachment identifier at the event contract boundary", async () => {
  const attachmentId = "🎉".repeat(512);
  const value = await connected(async () => reply({
    items: [{
      ...first,
      attachments: [{ type: "img", id: attachmentId, mimeType: "image/png" }],
    }],
    hasMore: false,
  }));
  const event = (await value.backfill(null)).events[0]!;
  expect(event.attachments[0]?.attachment_id).toBe(attachmentId);
  expect(validateEventInput(event).ok).toBe(true);
});

test("refuses malformed attachment pages and clears attachment references on tombstones", async () => {
  const invalidSize = await connected(async () => reply({ items: [{ ...first, attachments: [{ type: "img", fileSize: -1 }] }], hasMore: false }));
  await expect(invalidSize.backfill(null)).rejects.toThrow("malformed message");
  const tooMany = await connected(async () => reply({ items: [{ ...first, attachments: Array.from({ length: 101 }, () => ({ type: "unknown" })) }], hasMore: false }));
  await expect(tooMany.backfill(null)).rejects.toThrow("malformed message");
  const tombstone = await connected(async () => reply({ items: [{ ...deleted, attachments: [{ type: "img", id: "mxc://gone" }] }], hasMore: false }));
  expect((await tombstone.backfill(null)).events[0]).toMatchObject({ deleted: true, attachments: [] });
});

test("uses unambiguous tuple identities across colon-containing provider identifiers", async () => {
  const value = await connected(async () => reply({
    items: [
      { ...first, id: "c:one", accountID: "a", chatID: "b:c" },
      { ...first, id: "one", accountID: "a:b", chatID: "c" },
    ], hasMore: false,
  }));
  const batch = await value.backfill(null);
  expect(batch.events.map((event) => event.source_record_id)).toEqual(['["a","b:c","c:one"]', '["a:b","c","one"]']);
  expect(batch.events[0]?.subjects[0]?.subject_id).toBe('beeper:sender:["a","u1"]');
});

test("health probes local Beeper with the token and distinguishes rejection, outage, and malformed info", async () => {
  const requests: string[] = [];
  const healthy = await connected(async (url, init) => {
    requests.push(url.pathname);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    return reply({ app: { name: "Beeper", version: "fixture" }, server: { status: "ready" } });
  });
  expect((await healthy.health()).state).toBe("ok");
  expect(requests).toEqual(["/v1/info"]);
  const rejected = await connected(async () => reply({}, 401));
  expect((await rejected.health()).state).toBe("unauthenticated");
  const offline = await connected(async () => { throw new Error("offline"); });
  expect((await offline.health()).state).toBe("unreachable");
  const malformed = await connected(async () => new Response("not-json"));
  expect((await malformed.health()).state).toBe("misconfigured");
});

test("refuses malformed pages and looping cursors without advancing", async () => {
  const malformed = await connected(async () => reply({ items: [{}], hasMore: false }));
  await expect(malformed.backfill(null)).rejects.toThrow("malformed message");
  const empty = await connected(async () => reply({ items: [], hasMore: true, oldestCursor: "next" }));
  await expect(empty.backfill(null)).rejects.toThrow("empty page claims more history");
  const looping = await connected(async () => reply({ items: [first], hasMore: true, oldestCursor: "same" }));
  await expect(looping.backfill(JSON.stringify({ schema: "kizuki.beeper-cursor/v1", cursor: "same" }))).rejects.toThrow("invalid pagination cursor");
});

test("fails closed for non-loopback URLs and secret resolution never returns the token", async () => {
  expect(() => new BeeperConnector({ token_secret_ref: "env:T", base_url: "https://sealgate.ai" })).toThrow("loopback");
  expect(() => new BeeperConnector({ token_secret_ref: "env:T", base_url: "http://localhost:23373" })).toThrow("loopback");
  expect(() => new BeeperConnector({ token_secret_ref: "env:T", base_url: "http://127.0.0.2:23373" })).toThrow("loopback");
  expect(() => new BeeperConnector({ token_secret_ref: "env:T", base_url: "http://[::1]:23373" })).toThrow("loopback");
  expect(() => new BeeperConnector({ token_secret_ref: "env:T", base_url: "http://user:pass@127.0.0.1:23373" })).toThrow("loopback");
  const value = connector(async () => reply({ items: [], hasMore: false }));
  await expect(value.backfill(null)).rejects.toThrow("connect() has not been called");
  await expect(value.connect(async () => { throw new Error(TOKEN); })).rejects.not.toThrow(TOKEN);
});

test("reports timeout/unreachable as unavailable without a checkpoint advance and revocation clears access", async () => {
  const value = await connected(async () => { throw new DOMException("late", "TimeoutError"); });
  const batch = await value.backfill(null);
  expect(batch).toMatchObject({ events: [], cursor: null, status: "unavailable" });
  await value.revoke();
  expect((await value.health()).state).toBe("disabled");
  await expect(value.sync(null)).rejects.toThrow("access was revoked");
});

test("manifest states the read-only local connector contract", () => {
  const manifest = connector(async () => reply({ items: [], hasMore: false })).manifest();
  expect(manifest.connector_id).toBe(BEEPER_CONNECTOR_ID);
  expect(manifest).toMatchObject({ auth_modes: ["secret_ref"], required_secrets: ["env:BEEPER_TOKEN"], default_sensitivity: "private", sensitivity_floor: "personal", capabilities: { tombstones: true, purge: false } });
});

test("passes the shared connector conformance suite with synthetic local API data", async () => {
  let deletedAtSource = false;
  const value = await connected(async () => reply({ items: [deletedAtSource ? deleted : first], hasMore: false }));
  const result = await runConformance(value, {
    tombstone: {
      prepare: async () => (await value.backfill(null)).cursor,
      mutate: async () => { deletedAtSource = true; },
    },
  });
  expect(result).toEqual({ pass: true, failures: [] });
});

const newer = { id: "m3", accountID: "a1", chatID: "c1", senderID: "u3", sortKey: "003", timestamp: "2026-01-02T03:06:05Z", text: "arrived after the walk" };

test("ends the backward walk on a forward anchor and then polls only newer messages", async () => {
  const seen: (string | null)[][] = [];
  const value = await connected(async (input) => {
    const url = new URL(input.toString());
    const direction = url.searchParams.get("direction");
    const cursor = url.searchParams.get("cursor");
    seen.push([direction, cursor]);
    if (direction === "before") {
      return cursor === null
        ? reply({ items: [first], hasMore: true, oldestCursor: "older", newestCursor: "newest" })
        : reply({ items: [deleted], hasMore: false, oldestCursor: "oldest", newestCursor: "older" });
    }
    return cursor === "newest"
      ? reply({ items: [newer], hasMore: false, newestCursor: "newest-2" })
      : reply({ items: [], hasMore: false });
  });
  const opening = await value.backfill(null);
  expect(opening.has_more).toBe(true);
  const closing = await value.backfill(opening.cursor);
  expect(closing.has_more).toBe(false);
  expect(closing.cursor).not.toBeNull();

  const caught = await value.sync(closing.cursor);
  expect(caught.events.map((event) => event.source_record_id)).toEqual(['["a1","c1","m3"]']);
  expect(caught.has_more).toBe(false);
  const quiet = await value.sync(caught.cursor);
  expect(quiet.events).toEqual([]);
  expect(quiet.cursor).toBe(caught.cursor);
  expect(seen).toEqual([["before", null], ["before", "older"], ["after", "newest"], ["after", "newest-2"]]);
});

test("sync without a stored anchor reads one newest page instead of draining history", async () => {
  const seen: (string | null)[][] = [];
  const value = await connected(async (input) => {
    const url = new URL(input.toString());
    seen.push([url.searchParams.get("direction"), url.searchParams.get("cursor")]);
    return url.searchParams.get("direction") === "before"
      ? reply({ items: [first], hasMore: true, oldestCursor: "older", newestCursor: "top" })
      : reply({ items: [], hasMore: false });
  });
  const bootstrap = await value.sync(null);
  expect(bootstrap.events).toHaveLength(1);
  expect(bootstrap.has_more).toBe(false);
  const polled = await value.sync(bootstrap.cursor);
  expect(polled.events).toEqual([]);
  expect(seen).toEqual([["before", null], ["after", "top"]]);
});

test("a sync resumed from an unfinished backward walk finishes it before polling forward", async () => {
  const seen: (string | null)[][] = [];
  const value = await connected(async (input) => {
    const url = new URL(input.toString());
    const cursor = url.searchParams.get("cursor");
    seen.push([url.searchParams.get("direction"), cursor]);
    return url.searchParams.get("direction") === "before"
      ? reply({ items: [deleted], hasMore: false, oldestCursor: "oldest", newestCursor: "older" })
      : reply({ items: [], hasMore: false });
  });
  const unfinished = JSON.stringify({ schema: "kizuki.beeper-cursor/v1", phase: "backfill", before: "older", after: "newest" });
  const drained = await value.sync(unfinished);
  expect(drained.has_more).toBe(false);
  const polled = await value.sync(drained.cursor);
  expect(polled.events).toEqual([]);
  expect(seen).toEqual([["before", "older"], ["after", "newest"]]);
});

test("accepts a checkpoint written before the forward poll existed", async () => {
  const seen: (string | null)[][] = [];
  const value = await connected(async (input) => {
    const url = new URL(input.toString());
    seen.push([url.searchParams.get("direction"), url.searchParams.get("cursor")]);
    return reply({ items: [first], hasMore: false, newestCursor: "top" });
  });
  const legacy = JSON.stringify({ schema: "kizuki.beeper-cursor/v1", cursor: "older" });
  const batch = await value.backfill(legacy);
  expect(batch.events).toHaveLength(1);
  expect(seen).toEqual([["before", "older"]]);
});

test("refuses a forward page that does not advance the anchor", async () => {
  const value = await connected(async () => reply({ items: [newer], hasMore: true, newestCursor: "same" }));
  const anchored = JSON.stringify({ schema: "kizuki.beeper-cursor/v1", phase: "sync", before: null, after: "same" });
  await expect(value.sync(anchored)).rejects.toThrow("invalid pagination cursor");
  const unanchored = await connected(async () => reply({ items: [newer], hasMore: true }));
  const point = JSON.stringify({ schema: "kizuki.beeper-cursor/v1", phase: "sync", before: null, after: "point" });
  await expect(unanchored.sync(point)).rejects.toThrow("malformed pagination response");
});

test("manifest declares that the first sync resumes an unfinished backward walk", () => {
  const manifest = connector(async () => reply({ items: [], hasMore: false })).manifest();
  expect(manifest.capabilities.sync_from_backfill_before_first_success).toBe(true);
});

test("a walk restarted from the top anchors on the newest point it sees now", async () => {
  let top = "newest-1";
  const seen: (string | null)[][] = [];
  const value = await connected(async (input) => {
    const url = new URL(input.toString());
    seen.push([url.searchParams.get("direction"), url.searchParams.get("cursor")]);
    return url.searchParams.get("direction") === "before"
      ? reply({ items: [first], hasMore: false, newestCursor: top })
      : reply({ items: [], hasMore: false });
  });
  const opening = await value.backfill(null);
  top = "newest-2";
  const restarted = await value.backfill(opening.cursor);
  expect(restarted.cursor).not.toBe(opening.cursor);
  await value.sync(restarted.cursor);
  expect(seen).toEqual([["before", null], ["before", null], ["after", "newest-2"]]);
});
