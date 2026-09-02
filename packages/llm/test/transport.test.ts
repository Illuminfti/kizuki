import { afterEach, describe, expect, test } from "bun:test";
import { fetchTransport, readBoundedBody } from "../src/transport";
import type { ChatRequest, TransportOptions } from "../src/transport";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";

const request: ChatRequest = {
  model: "m",
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ],
  temperature: 0,
  max_tokens: 32,
};

let endpoint: FakeEndpoint | undefined;
afterEach(async () => {
  await endpoint?.stop();
  endpoint = undefined;
});

function options(
  url: string,
  overrides: Partial<TransportOptions> = {},
): TransportOptions {
  return {
    url: `${url}/chat/completions`,
    api_key: null,
    timeout_ms: 5_000,
    max_response_bytes: 1_048_576,
    ...overrides,
  };
}

describe("transport", () => {
  test("posts JSON and returns the parsed body", async () => {
    endpoint = startFakeEndpoint([{ body: chatCompletion("hello") }]);
    const result = await fetchTransport(request, options(endpoint.url));
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.body).toEqual(request as unknown as object);
  });

  test("sends a bearer header only when a key was resolved", async () => {
    endpoint = startFakeEndpoint([{}, {}]);
    await fetchTransport(request, options(endpoint.url));
    await fetchTransport(request, options(endpoint.url, { api_key: "k" }));
    expect(endpoint.requests[0]?.headers["authorization"]).toBeUndefined();
    expect(endpoint.requests[1]?.headers["authorization"]).toBe("Bearer k");
  });

  test("a declared content-length over the cap is refused unread", async () => {
    endpoint = startFakeEndpoint([{ raw: "x".repeat(4_096) }]);
    const result = await fetchTransport(
      request,
      options(endpoint.url, { max_response_bytes: 1_024 }),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "too_large" });
  });

  test("a chunked reply with no content-length stops at the cap", async () => {
    // Regression: the cap used to fire only after the whole body had been
    // buffered, so an endpoint that streams could drive allocation at will.
    endpoint = startFakeEndpoint([{ stream_bytes: 8 * 1_048_576 }]);
    const result = await fetchTransport(
      request,
      options(endpoint.url, { max_response_bytes: 1_024 }),
    );
    expect(result).toEqual({ ok: false, status: 0, failure: "too_large" });
  });

  test("the bounded reader stops pulling once the cap is passed", async () => {
    const chunk = new Uint8Array(65_536).fill(120);
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunk.byteLength;
        controller.enqueue(chunk);
        if (produced >= 64 * 1_048_576) controller.close();
      },
    });
    const text = await readBoundedBody(new Response(stream), 1_024);
    expect(text).toBeNull();
    expect(produced).toBeLessThan(4 * 1_048_576);
  });

  test("a non-2xx answer reports its status and retry-after", async () => {
    endpoint = startFakeEndpoint([
      { status: 429, headers: { "retry-after": "3" }, raw: "slow down" },
    ]);
    const result = await fetchTransport(request, options(endpoint.url));
    expect(result).toEqual({
      ok: false,
      status: 429,
      retry_after_ms: 3_000,
    });
  });

  test("a body that is not JSON is a failure, not a value", async () => {
    endpoint = startFakeEndpoint([{ raw: "not json" }]);
    const result = await fetchTransport(request, options(endpoint.url));
    expect(result).toEqual({ ok: false, status: 0, failure: "not_json" });
  });

  test("a redirect is refused rather than followed", async () => {
    endpoint = startFakeEndpoint([
      { status: 302, headers: { location: "https://example.invalid/v1" } },
    ]);
    const result = await fetchTransport(request, options(endpoint.url));
    expect(result).toEqual({ ok: false, status: 0, failure: "redirect" });
  });

  test("a slow endpoint times out", async () => {
    endpoint = startFakeEndpoint([{ delay_ms: 2_000 }]);
    const slow = await fetchTransport(
      request,
      options(endpoint.url, { timeout_ms: 100 }),
    );
    expect(slow).toEqual({ ok: false, status: 0, failure: "timeout" });
  });

  test("a refused port is a network failure", async () => {
    const closed = startFakeEndpoint([{}]);
    const url = closed.url;
    await closed.stop();
    const result = await fetchTransport(request, options(url));
    expect(result).toEqual({ ok: false, status: 0, failure: "network" });
  });
});
