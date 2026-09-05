import { expect, test } from "bun:test";
import { runConformance } from "../../../connectors/src/conformance";
import { createXApiConnector } from "../../src/api";
import { XApiFixture } from "../../src/api/testkit";
import { digest, encodeState, parseCursor, parseState, selection } from "../../src/api/state";

const ids = (events: { source_record_id: string }[]) => events.map(event => event.source_record_id);
test("history selection refuses precision that would widen the requested lower boundary", () => {
  for (const start of ["2026-01-01T00:00:00.0001Z", "2026-01-01T01:00:00.123001+01:00"]) {
    expect(() => selection({ fields: [], history_start: start, wire_profile: "tweet-v2" })).toThrow("misconfigured");
  }
  expect(selection({ fields: [], history_start: "2026-01-01T01:00:00.123000+01:00", wire_profile: "tweet-v2" }).history_start).toBe("2026-01-01T00:00:00.123Z");
});

test("bounded pages retain the old frontier until the whole available walk is accepted", async () => {
  const f = new XApiFixture(5), port = await f.connected();
  let cursor: string | null = null; const collected: string[] = [];
  for (let page = 0; page < 3; page++) {
    const batch = await port.backfill(cursor); expect(batch.status).toBeUndefined(); collected.push(...ids(batch.events));
    const next = parseCursor(batch.cursor!);
    expect(next.committed).toBe(page === 2 ? "104" : null); expect(next.end).toBe(f.time.toISOString());
    cursor = batch.cursor;
  }
  expect(new Set(collected)).toEqual(new Set(["post:100", "post:101", "post:102", "post:103", "post:104"]));
  expect((await port.sync(cursor)).events).toEqual([]);
  expect(parseState(f.state).pending).toBeNull();
  expect(f.requests.some(request => new URL(request.url).searchParams.get("since_id") === "104")).toBe(true);
  f.records.push({ id: "105", author_id: "7", created_at: "2026-01-04T00:00:00Z", text: "Later synthetic post." });
  f.time = new Date("2026-02-02T00:00:00Z");
  expect(ids((await port.sync(cursor)).events)).toEqual(["post:105"]);
  await port.close();
});

test("a durable content-free pending plan replays exact IDs after restart and provider page reordering", async () => {
  const f = new XApiFixture(3); let port = await f.connected();
  const first = await port.backfill(null), state = new TextDecoder().decode(f.state);
  expect(parseState(f.state).pending?.entries).toHaveLength(2); expect(state).not.toContain("Synthetic own post");
  await port.close();
  f.records.push({ id: "999", author_id: "7", created_at: "2026-01-05T00:00:00Z", text: "Inserted into the provider list." });
  port = await f.connected();
  expect(await port.backfill(null)).toEqual(first);
  expect(new URL(f.requests.at(-1)!.url).pathname).toBe("/2/tweets");
  const before = f.state.slice(); f.records.find(row => row.id === "102")!.text = "Changed provider content.";
  const refused = await port.backfill(null); expect(refused.status).toBe("unavailable"); expect(refused.events).toEqual([]); expect(refused.cursor).toBeNull();
  expect(f.state).toEqual(before); expect(refused.detail).toContain("snapshot_changed");
  await port.close();
});

test("missing provider records and permission/billing failures never create tombstones", async () => {
  const f = new XApiFixture(2), port = await f.connected();
  const first = await port.backfill(null); f.records.pop();
  expect((await port.backfill(null)).status).toBe("unavailable");
  for (const status of [402, 403, 404, 500]) {
    f.failStatus = status; const batch = await port.sync(first.cursor);
    expect(batch.status).toBe("unavailable"); expect(batch.cursor).toBe(first.cursor); expect(batch.events).toEqual([]);
    expect(batch.detail).not.toContain("CANARY");
    if (status === 402) expect(batch.detail).toContain("billing_required");
    if (status === 403) expect(batch.detail).toContain("permission_denied");
  }
  const manifest = port.manifest(); expect(manifest.capabilities.tombstones).toBe(false); expect(manifest.capabilities.purge).toBe(false);
  await expect(port.purgeSource("x:user:7")).rejects.toThrow("not_supported"); await port.close();
});

test("empty continuation and a rejected continuation resume without promoting the pending head", async () => {
  const f = new XApiFixture(5), port = await f.connected();
  let injected = false;
  f.before = async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/tweets") && !injected) { injected = true; return Response.json({ meta: { result_count: 0, next_token: "page-0" } }); }
  };
  const empty = await port.backfill(null); expect(empty.events).toEqual([]); expect(parseCursor(empty.cursor!).phase).toBe("walk");
  const first = await port.sync(empty.cursor); expect(first.events).toHaveLength(2); expect(parseCursor(first.cursor!).committed).toBeNull();
  let rejected = false;
  f.before = async request => {
    const url = new URL(request.url);
    if (url.searchParams.has("pagination_token") && !rejected) { rejected = true; return Response.json({ detail: "CANARY" }, { status: 400 }); }
  };
  const restarted = await port.sync(first.cursor); expect(restarted.status).toBeUndefined(); expect(parseCursor(restarted.cursor!).restarts).toBe(1);
  expect(parseCursor(restarted.cursor!).committed).toBeNull();
  const requests = f.requests.filter(request => new URL(request.url).pathname.endsWith("/tweets")).slice(-2).map(request => new URL(request.url));
  expect(requests[0]!.searchParams.get("pagination_token")).not.toBeNull(); expect(requests[1]!.searchParams.get("pagination_token")).toBeNull();
  expect(requests[1]!.searchParams.get("end_time")).toBe(requests[0]!.searchParams.get("end_time"));
  await port.close();
});

test("cyclic tokens, malformed cursors and out-of-window provider rows cannot advance", async () => {
  const f = new XApiFixture(), port = await f.connected();
  f.before = async request => request.url.includes("/tweets?") ? Response.json({ meta: { result_count: 0, next_token: "repeat" } }) : undefined;
  const first = await port.backfill(null); const failed = await port.sync(first.cursor);
  expect(failed.status).toBe("unavailable"); expect(failed.cursor).toBe(first.cursor); expect(failed.detail).toContain("pagination_gap");
  const calls = f.requests.length;
  await expect(port.sync("CANARY invalid json")).rejects.toThrow("invalid_cursor"); expect(f.requests).toHaveLength(calls);
  const forged = JSON.stringify({ ...parseCursor(first.cursor!), account: "8" });
  expect((await port.sync(forged)).status).toBe("unavailable"); expect(f.requests).toHaveLength(calls);
  await port.close();
  const other = new XApiFixture(1), source = await other.connected();
  other.before = async request => request.url.includes("/tweets?") ? Response.json({ data: [{ id: "100", author_id: "7", text: "Future event.", created_at: "2026-02-01T00:00:00.0001Z" }], meta: { result_count: 1 } }) : undefined;
  expect((await source.sync(null)).status).toBe("unavailable"); expect(parseState(other.state).pending).toBeNull(); await source.close();
});

test("rate limits survive restart, while health and local revoke consume no provider requests", async () => {
  const f = new XApiFixture(); let port = await f.connected(); f.failStatus = 429;
  expect((await port.sync(null)).detail).toContain("rate_limited"); const cooldown = parseState(f.state).retry_at;
  expect(cooldown).toBe("2026-02-01T00:01:00.000Z"); await port.close(); const calls = f.requests.length;
  port = await f.connected(); expect(f.requests).toHaveLength(calls); expect((await port.health()).state).toBe("rate_limited");
  expect((await port.sync(null)).status).toBe("unavailable"); expect(f.requests).toHaveLength(calls);
  await port.revoke(); await port.revoke(); expect((await port.health()).state).toBe("disabled");
  await expect(port.sync(null)).rejects.toThrow(); expect(f.requests).toHaveLength(calls);
});

test("source configuration and saved authorization refuse before provider work", async () => {
  const f = new XApiFixture();
  await expect(createXApiConnector({}, f.deps()).connect(async () => "")).rejects.toThrow("misconfigured");
  await expect(createXApiConnector(f.config(), { persist: f.persist }).signIn(f.io, { write: f.persist }, { mode: "new" })).rejects.toThrow("misconfigured");
  expect(() => createXApiConnector({ secret_ref: "SYNTHETIC_X_ACCESS_CANARY_0" })).toThrow("misconfigured");
  for (const transform of [
    (raw: ReturnType<typeof parseState>) => { raw.app = digest("another-app"); },
    (raw: ReturnType<typeof parseState>) => { raw.oauth.account.id = "8"; },
    (raw: ReturnType<typeof parseState>) => { raw.oauth.tokens.scope = "tweet.read"; },
    (raw: ReturnType<typeof parseState>) => { raw.selection = selection({ ...raw.selection, fields: ["links"] }); },
  ]) {
    const raw = parseState(f.state); transform(raw);
    await expect(createXApiConnector(f.config(), f.deps()).connect(async () => JSON.stringify(raw))).rejects.toThrow();
  }
  expect(f.requests).toEqual([]); expect(f.forms).toEqual([]); expect(f.authorizations).toEqual([]);
});

test("shared conformance runs through the synthetic API peer with the real parser", async () => {
  const f = new XApiFixture(2), port = await f.connected();
  const result = await runConformance(port, { backfillTwice: true });
  expect(result.failures).toEqual([]); expect(result.pass).toBe(true);
  expect(JSON.stringify([port.manifest(), await port.health()])).not.toContain("SYNTHETIC_X_ACCESS_CANARY");
});

test("a failed reload removes prior credentials and returns the host's unavailable batch without advancing", async () => {
  const f = new XApiFixture(1), port = await f.connected();
  await expect(port.connect(async () => { throw Error("SYNTHETIC_SECRET_READER_CANARY"); })).rejects.toThrow();
  f.requests = [];
  expect(await port.sync(null)).toMatchObject({ events: [], cursor: null, status: "unavailable" });
  expect(f.requests).toEqual([]); expect((await port.health()).state).not.toBe("ok");
});

test("one rejected continuation cannot replenish the cumulative frozen-walk budget", async () => {
  const f = new XApiFixture(64, 1), port = await f.connected(); let rejected = false, continuations = 0, stopped = false;
  f.before = async request => {
    if (new URL(request.url).searchParams.get("pagination_token") === "page-5" && !rejected) { rejected = true; return Response.json({}, { status: 400 }); }
  };
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const batch = await port.sync(cursor);
    if (batch.status === "unavailable") { expect(batch.cursor).toBe(cursor); expect(batch.detail).toContain("pagination_gap"); stopped = true; break; }
    const decoded = parseCursor(batch.cursor!); expect(decoded.committed).toBeNull();
    if (decoded.phase === "walk") continuations++;
    expect(decoded.pages).toBe(continuations); cursor = batch.cursor;
  }
  expect(rejected).toBe(true); expect(stopped).toBe(true); expect(continuations).toBe(64);
  expect(parseCursor(cursor!).restarts).toBe(1); expect(parseCursor(cursor!).seen.length).toBeLessThan(parseCursor(cursor!).pages);
  expect(parseState(f.state).checkpoint).toBe(cursor); await port.close();
});
