import { afterEach, describe, expect, test } from "bun:test";
import { fetchTransport } from "../src/index";
import {
  defaultChatCompletion,
  startFakeEndpoint,
} from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";

const BODY = {
  model: "synthetic",
  messages: [
    { role: "system", content: "Extract claims." },
    { role: "user", content: "Grace runs partnerships at Acme." },
  ],
  max_tokens: 64,
};

describe("fetchTransport", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("posts chat completions to the configured loopback URL", async () => {
    fake = startFakeEndpoint();
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: "canary-key-ada-not-secret",
      timeout_ms: 1_000,
      max_response_bytes: 4_096,
      body: BODY,
    });

    expect(result).toEqual({
      ok: true,
      kind: "ok",
      status: 200,
      body: expect.objectContaining({
        choices: [
          expect.objectContaining({
            message: {
              role: "assistant",
              content: "Grace runs partnerships at Acme.",
            },
          }),
        ],
      }),
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/v1/chat/completions",
        body: BODY,
      }),
    );
    const headers = fake.requests[0]?.headers ?? {};
    expect(headers["content-type"]).toContain("application/json");
    expect(headers["accept"]).toContain("application/json");
    expect(headers["authorization"]).toBe(
      "Bearer canary-key-ada-not-secret",
    );
    expect(
      Object.keys(headers).filter((name) => name.startsWith("x-")),
    ).toEqual([]);
  });

  test("omits authorization when no key is configured", async () => {
    fake = startFakeEndpoint();
    await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 1_000,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(fake.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  test("returns http status without following a redirect", async () => {
    fake = startFakeEndpoint((seen) => {
      if (seen.path === "/v1/chat/completions") {
        return new Response(null, {
          status: 302,
          headers: { location: "/v1/other" },
        });
      }
      return defaultChatCompletion();
    });
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 1_000,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.kind === "transport") {
      expect(result.failure).toBe("redirect");
    } else {
      expect(result.status).toBe(302);
    }
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/v1/chat/completions",
    ]);
  });

  test("maps 429 retry-after to milliseconds", async () => {
    fake = startFakeEndpoint(
      () =>
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
    );
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 1_000,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      kind: "http",
      status: 429,
      retry_after_ms: 1_000,
    });
  });

  test("times out a slow endpoint", async () => {
    fake = startFakeEndpoint(async () => {
      await Bun.sleep(200);
      return defaultChatCompletion();
    });
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 50,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      kind: "transport",
      status: 0,
      failure: "timeout",
    });
  });

  test("rejects an oversized response before parsing it", async () => {
    fake = startFakeEndpoint(
      () =>
        new Response("x".repeat(64), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "64",
          },
        }),
    );
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 1_000,
      max_response_bytes: 16,
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      kind: "transport",
      status: 0,
      failure: "too_large",
    });
  });

  test("bounds a chunked multibyte loopback response without exposing its content", async () => {
    const responseCanary = "response-private-canary";
    const keyCanary = "credential-private-canary";
    fake = startFakeEndpoint(() => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`{\"x\":\"${responseCanary}😀`));
        await Bun.sleep(25);
        controller.enqueue(new TextEncoder().encode("😀😀\"}"));
      },
    })));
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: keyCanary,
      timeout_ms: 1_000,
      max_response_bytes: 32,
      body: BODY,
    });
    expect(result).toMatchObject({ ok: false, kind: "transport", failure: "too_large" });
    expect(JSON.stringify(result)).not.toContain(responseCanary);
    expect(JSON.stringify(result)).not.toContain(keyCanary);
  });

  test("cancels the response reader immediately after crossing the byte bound", async () => {
    let cancelled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
      },
      cancel() { cancelled = true; },
    }))) as unknown as typeof fetch;
    try {
      const result = await fetchTransport({
        url: "http://127.0.0.1:9/v1/chat/completions",
        api_key: null,
        timeout_ms: 1_000,
        max_response_bytes: 7,
        body: BODY,
      });
      expect(result).toMatchObject({ ok: false, kind: "transport", failure: "too_large" });
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a non-json 200", async () => {
    fake = startFakeEndpoint(() => new Response("not-json", { status: 200 }));
    const result = await fetchTransport({
      url: `${fake.base_url}/chat/completions`,
      api_key: null,
      timeout_ms: 1_000,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      kind: "transport",
      status: 0,
      failure: "not_json",
    });
  });

  test("maps a closed loopback port to network", async () => {
    const result = await fetchTransport({
      url: "http://127.0.0.1:9/v1/chat/completions",
      api_key: null,
      timeout_ms: 250,
      max_response_bytes: 4_096,
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      kind: "transport",
      status: 0,
      failure: "network",
    });
  });
});
