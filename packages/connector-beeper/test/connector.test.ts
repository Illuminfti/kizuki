import { expect, test } from "bun:test";
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
  expect(one.events[0]?.source_record_id).toBe('["a1","c1","m1"]');
  expect(one.events[0]?.metadata).toEqual({ source_kind: "beeper", account_id: "a1", chat_id: "c1", message_id: "m1", sender_id: "u1", sort_key: "001", edited_timestamp: null });
  const two = await value.backfill(one.cursor);
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
