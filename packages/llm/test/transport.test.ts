import { afterEach, describe, expect, test } from "bun:test";
import { fetchTransport } from "../src/transport";
import type { ChatRequest, TransportOptions } from "../src/transport";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";

const endpoints: FakeEndpoint[] = [];

function fake(...args: Parameters<typeof startFakeEndpoint>): FakeEndpoint {
  const endpoint = startFakeEndpoint(...args);
  endpoints.push(endpoint);
  return endpoint;
}

afterEach(() => {
  while (endpoints.length > 0) endpoints.pop()?.stop();
});

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "fake-model",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: '{"record":{"text":"ada met grace"}}' },
    ],
    temperature: 0,
    max_tokens: 64,
    ...overrides,
  };
}

function options(url: string, overrides: Partial<TransportOptions> = {}): TransportOptions {
  return {
    url,
    api_key: null,
    timeout_ms: 5000,
    max_response_bytes: 1_048_576,
    ...overrides,
  };
}

describe("fetchTransport", () => {
  test("posts the chat request and returns the parsed body", async () => {
    const endpoint = fake();
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: true, status: 200 }),
    );
    const seen = endpoint.requests[0];
    expect(seen?.path).toBe("/v1/chat/completions");
    expect(seen?.body).toEqual({
      model: "fake-model",
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: '{"record":{"text":"ada met grace"}}' },
      ],
      temperature: 0,
      max_tokens: 64,
    });
  });

  test("sends response_format only when the caller asks for it", async () => {
    const endpoint = fake();
    await fetchTransport(
      request({ response_format: { type: "json_object" } }),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(endpoint.requests[0]?.body).toEqual(
      expect.objectContaining({ response_format: { type: "json_object" } }),
    );
  });

  test("sends no authorization header without a key", async () => {
    const endpoint = fake();
    await fetchTransport(request(), options(`${endpoint.base_url}/chat/completions`));
    expect(endpoint.requests[0]?.headers["authorization"]).toBeUndefined();
  });

  test("sends only content-type, accept and authorization of its own", async () => {
    const endpoint = fake();
    await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`, { api_key: "k-1" }),
    );
    const headers = endpoint.requests[0]?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer k-1");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json");
    const added = new Set([
      "content-type",
      "accept",
      "authorization",
      "host",
      "content-length",
      "user-agent",
      "connection",
      "accept-encoding",
    ]);
    expect(Object.keys(headers).filter((name) => !added.has(name))).toEqual([]);
    expect(Object.keys(headers).filter((name) => name.startsWith("x-"))).toEqual([]);
  });

  test("reports a non-2xx status without reading the body", async () => {
    const endpoint = fake({
      reply: () => new Response("nope", { status: 401 }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result).toEqual({ ok: false, status: 401, retry_after_ms: null });
  });

  test("reads Retry-After seconds", async () => {
    const endpoint = fake({
      reply: () =>
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result).toEqual({ ok: false, status: 429, retry_after_ms: 1000 });
  });

  test("reads Retry-After as an HTTP date", async () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const endpoint = fake({
      reply: () =>
        new Response("slow down", { status: 503, headers: { "retry-after": when } }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result.ok).toBe(false);
    const retry = result.ok === false && "retry_after_ms" in result
      ? result.retry_after_ms
      : null;
    expect(retry).not.toBeNull();
    expect(retry ?? 0).toBeGreaterThan(20_000);
    expect(retry ?? 0).toBeLessThanOrEqual(30_000);
  });

  test("never follows a redirect", async () => {
    const endpoint = fake({
      reply: (seen) =>
        seen.path.endsWith("/moved")
          ? chatCompletion("{}")
          : new Response(null, {
              status: 302,
              headers: { location: "/v1/moved" },
            }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "redirect" });
    expect(endpoint.requests).toHaveLength(1);
  });

  test("times out a slow endpoint", async () => {
    const endpoint = fake({
      reply: async () => {
        await Bun.sleep(500);
        return chatCompletion("{}");
      },
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`, { timeout_ms: 100 }),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "timeout" });
  });

  test("refuses a response larger than the cap", async () => {
    const endpoint = fake({
      reply: () => new Response("x".repeat(5000), { status: 200 }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`, { max_response_bytes: 1024 }),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "too_large" });
  });

  test("refuses a 2xx body that is not JSON", async () => {
    const endpoint = fake({
      reply: () =>
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });
    const result = await fetchTransport(
      request(),
      options(`${endpoint.base_url}/chat/completions`),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "not_json" });
  });

  test("reports a refused connection as a network failure", async () => {
    const result = await fetchTransport(
      request(),
      options("http://127.0.0.1:9/v1/chat/completions", { timeout_ms: 2000 }),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "network" });
  });
});
