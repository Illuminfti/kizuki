import { expect, test } from "bun:test";
import { withDeadline } from "@kizuki/core";
import { createBeeperConnector } from "../src/connector";
import type { BeeperFetch } from "../src/connector";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function connected(fetch: BeeperFetch) {
  const connector = createBeeperConnector({ token_secret_ref: "env:SYNTHETIC_BEEPER_TOKEN" }, { fetch });
  await connector.connect(async () => "synthetic-token");
  return connector;
}

/** A body whose cancellation never settles, as a hostile local provider can make it. */
function hostileBody(start?: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    ...(start === undefined ? {} : { start }),
    cancel() { state.cancelled = true; return new Promise<void>(() => {}); },
  });
  return { body, state };
}

test("an oversized Beeper stream refuses without waiting for cancellation and releases the reader", async () => {
  const { body, state } = hostileBody(controller => controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)));
  let response = new Response(body);
  const connector = await connected(async () => response);
  try {
    await expect(withDeadline(connector.backfill(null), 1000, "stream-hung")).rejects.toMatchObject({ code: "parse_error" });
    expect(state.cancelled).toBe(true);
    expect(body.locked).toBe(false);
    response = Response.json({ items: [], hasMore: false });
    expect((await connector.backfill(null)).events).toEqual([]);
  } finally { await connector.revoke(); }
});

test("a declared length beyond the ceiling refuses before any byte is read and still cancels the body", async () => {
  for (const length of [String(MAX_BODY_BYTES + 1), "not-a-number"]) {
    const { body, state } = hostileBody();
    const connector = await connected(async () => new Response(body, { headers: { "content-length": length } }));
    try {
      await expect(withDeadline(connector.backfill(null), 1000, "stream-hung")).rejects.toMatchObject({ code: "parse_error" });
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally { await connector.revoke(); }
  }
});

test("a stalled Beeper body ends at the read deadline as an unavailable batch", async () => {
  const { body, state } = hostileBody();
  const connector = await connected(async () => new Response(body));
  // The production deadline is 15 seconds; compress long timers rather than wait for it.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number) =>
    realSetTimeout(handler, delay !== undefined && delay > 1000 ? 20 : delay)) as unknown as typeof setTimeout;
  try {
    await expect(withDeadline(connector.backfill(null), 1000, "stream-hung")).resolves.toMatchObject({ status: "unavailable", events: [], cursor: null });
    expect(state.cancelled).toBe(true);
    expect(body.locked).toBe(false);
  } finally { globalThis.setTimeout = realSetTimeout; await connector.revoke(); }
});

test("empty and tiny chunks preserve a valid page with bounded storage", async () => {
  const bytes = Buffer.from('{"items":[],"hasMore":false}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < 10_000; at++) controller.enqueue(new Uint8Array(0));
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const connector = await connected(async () => new Response(body));
  try {
    expect((await connector.backfill(null)).events).toEqual([]);
    expect(body.locked).toBe(false);
  } finally { await connector.revoke(); }
});
