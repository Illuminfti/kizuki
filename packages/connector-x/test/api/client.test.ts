import { expect, test } from "bun:test";
import { ApiBudget, HttpFailure, X_API_RESPONSE_BYTES, fieldsQuery, request } from "../../src/api/client";
import { XApiFixture } from "../../src/api/testkit";
import { selection } from "../../src/api/state";

const url = () => new URL("https://api.x.com/2/users/me");

test("request admission caps one operation at five fixed-origin GETs before transport", async () => {
  let calls = 0; const budget = new ApiBudget(() => 0), peer = async (input: Request) => {
    calls++; expect(input.method).toBe("GET"); expect(input.redirect).toBe("error"); expect(input.headers.get("authorization")).toBe("Bearer synthetic-token"); return Response.json({ data: { id: "7" } });
  };
  for (let i = 0; i < 5; i++) await request(url(), "synthetic-token", budget, peer);
  await expect(request(url(), "synthetic-token", budget, peer)).rejects.toThrow("request_limit"); expect(calls).toBe(5);
  for (const endpoint of ["https://evil.invalid/2/users/me", "https://api.x.com/2/users/me#fragment", "https://user:pass@api.x.com/2/users/me", "https://api.x.com/2/users/0/tweets", "https://api.x.com/2/users/7/likes"]) {
    await expect(request(new URL(endpoint), "synthetic-token", new ApiBudget(() => 0), peer)).rejects.toThrow("misconfigured");
  }
  expect(calls).toBe(5);
  const query = fieldsQuery(selection({ fields: ["media", "links", "relationships"], history_start: "2026-01-01T00:00:00Z", wire_profile: "tweet-v2" }));
  expect(query.get("tweet.fields")).toContain("author_id");
  expect(query.get("expansions")!.split(",")).toEqual(["entities.mentions.username", "attachments.media_keys"]);
  expect(query.get("user.fields")).toBe("id,username");
  const minimal = fieldsQuery(selection({ fields: [], history_start: "2026-01-01T00:00:00Z", wire_profile: "tweet-v2" }));
  expect(minimal.has("expansions")).toBe(false); expect(minimal.has("user.fields")).toBe(false);
});

test("oversized headers and streams, invalid UTF-8, malformed JSON and redirects refuse without provider prose", async () => {
  for (const kind of ["length", "stream", "utf8", "json", "redirect", "wrong-url"] as const) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(X_API_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } });
    const response = kind === "length" ? new Response(stream, { headers: { "content-length": String(X_API_RESPONSE_BYTES + 1) } }) : kind === "stream" ? new Response(stream) :
      kind === "utf8" ? new Response(new Uint8Array([0xc3, 0x28])) : kind === "json" ? new Response("SYNTHETIC_PROVIDER_BODY_CANARY") : Response.json({ data: { id: "7" } });
    if (kind === "redirect") Object.defineProperty(response, "redirected", { value: true });
    if (kind === "wrong-url") Object.defineProperty(response, "url", { value: "https://api.x.com/2/tweets" });
    let detail = ""; try { await request(url(), "synthetic-token", new ApiBudget(() => 0), async () => response); } catch (error) { detail = String(error); }
    expect(detail).toContain("X API"); expect(detail).not.toContain("SYNTHETIC_PROVIDER_BODY_CANARY");
    if (kind === "length" || kind === "stream") expect(cancelled).toBe(true);
  }
});

test("the whole-response deadline cancels a hanging body and a late fetch cannot resume reading", async () => {
  let cancelled = false, aborted = false;
  const budget = new ApiBudget(() => 0, 5);
  await expect(request(url(), "synthetic-token", budget, async input => {
    input.signal.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  })).rejects.toThrow("timeout");
  expect(cancelled).toBe(true); expect(aborted).toBe(true);
  let release!: (response: Response) => void, lateCancelled = false;
  const running = request(url(), "synthetic-token", new ApiBudget(() => 0, 5), async () => new Promise(resolve => { release = resolve; }));
  await expect(running).rejects.toThrow("timeout");
  release(new Response(new ReadableStream({ cancel() { lateCancelled = true; } })));
  await Bun.sleep(1); expect(lateCancelled).toBe(true);
});

test("429 bounds untrusted retry hints and status failures never copy response text", async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500]) {
    let error: unknown;
    try { await request(url(), "synthetic-token", new ApiBudget(() => 0), async () => new Response("SYNTHETIC_PROVIDER_BODY_CANARY", { status, headers: { "retry-after": "3456000" } })); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(HttpFailure); expect((error as HttpFailure).status).toBe(status);
    if (status === 429) expect((error as HttpFailure).retrySeconds).toBe(86_400);
    expect(String(error)).not.toContain("SYNTHETIC_PROVIDER_BODY_CANARY");
  }
});

test("delivered response header count and bytes are bounded before body normalization", async () => {
  for (const headers of [Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`x-synthetic-${i}`, "x".repeat(1024)])), { "x-synthetic-large": "x".repeat(16 * 1024) }]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":{"id":"7"}}')); }, cancel() { cancelled = true; } }), { headers });
    await expect(request(url(), "synthetic-token", new ApiBudget(() => 0), async () => response)).rejects.toThrow("response_limit");
    expect(cancelled).toBe(true);
  }
});

test("numeric/date retry hints clamp to one day and malformed hints use a fixed minute", async () => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  for (const [header, expected] of [["0", 1], ["120", 120], ["9999999999", 86_400], ["9".repeat(500), 86_400], ["tomorrow", 60], ["-1", 60], ["1.5", 60], ["", 60],
    ["Mon, 02 Feb 2026 00:00:00 GMT", 86_400], ["Sun, 01 Feb 2026 00:02:00 GMT", 120]] as const) {
    let error: unknown;
    try { await request(url(), "synthetic-token", new ApiBudget(() => 0), async () => Response.json({}, { status: 429, headers: { "retry-after": header } }), () => now); } catch (caught) { error = caught; }
    expect((error as HttpFailure).retrySeconds).toBe(expected);
  }
  let error: unknown;
  try { await request(url(), "synthetic-token", new ApiBudget(() => 0), async () => Response.json({}, { status: 429 }), () => now); } catch (caught) { error = caught; }
  expect((error as HttpFailure).retrySeconds).toBe(60);
});

test("expiry between identity and timeline admits no later request and a fresh operation recovers", async () => {
  const f = new XApiFixture(1); let clock = 0, expire = false;
  const port = await f.connected({ clock: () => clock });
  f.requests = []; f.before = async input => { if (expire && new URL(input.url).pathname === "/2/users/me") clock = 45_001; };
  expire = true; const result = await port.sync(null); expect(result.status).toBe("unavailable"); expect(result.cursor).toBeNull(); expect(f.requests).toHaveLength(1); expect(f.forms).toEqual([]);
  expire = false; clock = 0; expect((await port.sync(null)).events).toHaveLength(1); await port.close();
});
