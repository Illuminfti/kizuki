import { describe, expect, test } from "bun:test";
import { ChatClient } from "../src/client";
import type { ChatTransport, TransportResult } from "../src/transport";
import { fakeClock, llmConfig } from "./helpers";
import type { FakeClock } from "./helpers";
import type { LlmConfig } from "../src/config";

function completion(content: unknown, extra: Record<string, unknown> = {}): TransportResult {
  return {
    ok: true,
    status: 200,
    body: {
      model: "served-model",
      choices: [{ index: 0, message: { role: "assistant", content } }],
      ...extra,
    },
  };
}

interface Scripted {
  transport: ChatTransport;
  calls: { user: string; json_mode: boolean }[];
}

function scripted(results: TransportResult[]): Scripted {
  const calls: { user: string; json_mode: boolean }[] = [];
  let index = 0;
  const transport: ChatTransport = async (request) => {
    calls.push({
      user: request.messages[1].content,
      json_mode: request.response_format !== undefined,
    });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result === undefined) throw new Error("no scripted result");
    return result;
  };
  return { transport, calls };
}

function client(
  results: TransportResult[],
  overrides: Partial<LlmConfig> = {},
): { client: ChatClient; calls: Scripted["calls"]; clock: FakeClock } {
  const { transport, calls } = scripted(results);
  const clock = fakeClock();
  return {
    client: new ChatClient({
      config: llmConfig(overrides),
      api_key: null,
      transport,
      clock,
    }),
    calls,
    clock,
  };
}

describe("ChatClient", () => {
  test("builds the chat-completions url from the base url", () => {
    const built = client([completion("{}")], {
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(built.client.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  test("returns content, model and usage on success", async () => {
    const built = client([
      completion("{\"title\":\"t\"}", {
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
    ]);
    const outcome = await built.client.complete("system", "user");
    expect(outcome).toEqual({
      ok: true,
      content: "{\"title\":\"t\"}",
      model: "served-model",
      usage: { prompt_tokens: 12, completion_tokens: 5 },
      latency_ms: expect.any(Number),
    });
    expect(built.client.counters.prompt_tokens).toBe(12);
    expect(built.client.counters.completion_tokens).toBe(5);
  });

  test("leaves token counters null when no response reports usage", async () => {
    const built = client([completion("{}")]);
    await built.client.complete("system", "user");
    expect(built.client.counters.prompt_tokens).toBeNull();
    expect(built.client.counters.completion_tokens).toBeNull();
  });

  test("sends response_format only in json mode", async () => {
    const on = client([completion("{}")], { json_mode: true });
    await on.client.complete("system", "user");
    expect(on.calls[0]?.json_mode).toBe(true);
    const off = client([completion("{}")], { json_mode: false });
    await off.client.complete("system", "user");
    expect(off.calls[0]?.json_mode).toBe(false);
  });

  test("refuses a request past the request budget before touching the transport", async () => {
    const built = client([completion("{}")], { max_requests: 2 });
    await built.client.complete("system", "a");
    await built.client.complete("system", "b");
    const third = await built.client.complete("system", "c");
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.error.code).toBe("budget_exhausted");
    expect(built.calls).toHaveLength(2);
    expect(built.client.counters.requests).toBe(2);
  });

  test("refuses a request past the input-character budget", async () => {
    const built = client([completion("{}")], { max_input_chars: 10 });
    const first = await built.client.complete("system", "12345");
    expect(first.ok).toBe(true);
    const second = await built.client.complete("system", "1234567");
    expect(second.ok === false && second.error.code).toBe("budget_exhausted");
    expect(built.calls).toHaveLength(1);
    expect(built.client.counters.input_chars).toBe(5);
  });

  test("waits out the rate window instead of exceeding it", async () => {
    const built = client([completion("{}")], { requests_per_minute: 2 });
    await built.client.complete("system", "a");
    await built.client.complete("system", "b");
    const third = await built.client.complete("system", "c");
    expect(third.ok).toBe(true);
    expect(built.clock.slept).toHaveLength(1);
    expect(built.clock.slept[0]).toBe(60_000);
    expect(built.calls).toHaveLength(3);
  });

  test("retries a 429 exactly once and reports the retry-after wait", async () => {
    const built = client([
      { ok: false, status: 429, retry_after_ms: 1500 },
      completion("{}"),
    ]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok).toBe(true);
    expect(built.client.counters.requests).toBe(2);
    expect(built.clock.slept).toEqual([1500]);
  });

  test("caps the retry wait and defaults it when the endpoint gives none", async () => {
    const capped = client([
      { ok: false, status: 503, retry_after_ms: 120_000 },
      completion("{}"),
    ]);
    await capped.client.complete("system", "a");
    expect(capped.clock.slept).toEqual([30_000]);

    const defaulted = client([
      { ok: false, status: 502, retry_after_ms: null },
      completion("{}"),
    ]);
    await defaulted.client.complete("system", "a");
    expect(defaulted.clock.slept).toEqual([2000]);
  });

  test("gives up after one retry", async () => {
    const built = client([{ ok: false, status: 429, retry_after_ms: null }]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok === false && outcome.error.code).toBe("http_error");
    expect(outcome.ok === false && outcome.error.status).toBe(429);
    expect(built.client.counters.requests).toBe(2);
    expect(built.client.counters.errors).toBe(1);
  });

  test("does not retry a 500", async () => {
    const built = client([{ ok: false, status: 500, retry_after_ms: null }]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok === false && outcome.error.status).toBe(500);
    expect(built.calls).toHaveLength(1);
  });

  test("points an unauthorized endpoint at the api-key verb", async () => {
    for (const status of [401, 403]) {
      const built = client([{ ok: false, status, retry_after_ms: null }]);
      const outcome = await built.client.complete("system", "a");
      expect(outcome.ok === false && outcome.error.message).toEndWith(
        "; set api_key with: kizuki llm set --api-key env:VAR",
      );
    }
  });

  test("points a 400 in json mode at the json-mode switch", async () => {
    const on = client([{ ok: false, status: 400, retry_after_ms: null }], {
      json_mode: true,
    });
    const outcome = await on.client.complete("system", "a");
    expect(outcome.ok === false && outcome.error.message).toEndWith(
      "; if the endpoint rejects response_format run: kizuki llm set --no-json-mode",
    );
    const off = client([{ ok: false, status: 400, retry_after_ms: null }], {
      json_mode: false,
    });
    const plain = await off.client.complete("system", "a");
    expect(plain.ok === false && plain.error.message).not.toContain("--no-json-mode");
  });

  test.each([
    ["timeout", "timeout"],
    ["network", "network"],
    ["redirect", "redirect"],
    ["too_large", "response_too_large"],
    ["not_json", "bad_response"],
  ] as const)("maps transport failure %s to %s", async (failure, code) => {
    const built = client([{ ok: false, status: 0, failure }]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok === false && outcome.error.code).toBe(code);
    expect(built.client.counters.errors).toBe(1);
  });

  test.each([
    [{ ok: true, status: 200, body: { choices: [] } }],
    [{ ok: true, status: 200, body: { choices: [{ message: { content: null } }] } }],
    [{ ok: true, status: 200, body: { model: "m" } }],
    [{ ok: true, status: 200, body: [] }],
  ] as TransportResult[][])("refuses a malformed completion %#", async (result) => {
    const built = client([result]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok === false && outcome.error.code).toBe("bad_response");
  });

  test("ignores tool calls and unknown fields around the content", async () => {
    const built = client([
      {
        ok: true,
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: "{}",
                tool_calls: [{ id: "call-1", function: { name: "rm" } }],
              },
            },
          ],
          system_fingerprint: "ignored",
        },
      },
    ]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome).toEqual(
      expect.objectContaining({ ok: true, content: "{}", model: null }),
    );
  });

  test("ignores non-integer usage without failing the response", async () => {
    const built = client([
      completion("{}", { usage: { prompt_tokens: "12", completion_tokens: 1.5 } }),
    ]);
    const outcome = await built.client.complete("system", "a");
    expect(outcome.ok).toBe(true);
    expect(built.client.counters.prompt_tokens).toBeNull();
  });

  test("counts a mixed sequence on every path", async () => {
    const built = client(
      [
        completion("abcd", { usage: { prompt_tokens: 3, completion_tokens: 2 } }),
        { ok: false, status: 500, retry_after_ms: null },
        completion("ef", { usage: { prompt_tokens: 4, completion_tokens: 1 } }),
      ],
      { max_requests: 10 },
    );
    await built.client.complete("system", "12345");
    await built.client.complete("system", "12345");
    await built.client.complete("system", "12345");
    expect(built.client.counters).toEqual({
      requests: 3,
      input_chars: 15,
      output_chars: 6,
      prompt_tokens: 7,
      completion_tokens: 3,
      errors: 1,
    });
  });
});
