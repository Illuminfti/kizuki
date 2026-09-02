import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import type { LlmRequest } from "@kizuki/core";
import { LlmRejection } from "../src/errors";
import { readLlmPortConfig } from "../src/config";
import { OPENAI_COMPATIBLE_LLM, OpenAiCompatibleLlm } from "../src/llm-port";
import type { Clock } from "../src/llm-port";
import type { ChatTransport, TransportResult } from "../src/transport";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { llmPort } from "./helpers";

const cleanups: (() => void)[] = [];
let endpoint: FakeEndpoint | undefined;

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await endpoint?.stop();
  endpoint = undefined;
});

function port(
  config: Record<string, unknown>,
  overrides: Parameters<typeof llmPort>[1] = {},
  secrets?: (ref: string) => Promise<string>,
): OpenAiCompatibleLlm {
  const built = llmPort(config, overrides, secrets);
  cleanups.push(built.cleanup);
  return built.port;
}

const request: LlmRequest = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ],
  max_output_tokens: 128,
  deadline_ms: 5_000,
};

function refuses(config: Record<string, unknown>): string {
  try {
    readLlmPortConfig(config);
  } catch (error) {
    expect(error).toBeInstanceOf(PortError);
    return (error as PortError).message;
  }
  throw new Error("the config was accepted");
}

describe("configuration", () => {
  test("defaults are filled in and the base url is normalized", () => {
    expect(
      readLlmPortConfig({ base_url: "https://host/v1/", model: "m" }),
    ).toEqual({
      base_url: "https://host/v1",
      model: "m",
      secret_ref: null,
      timeout_ms: 60_000,
      max_retries: 2,
      requests_per_minute: 30,
      temperature: 0,
      json_mode: true,
      max_response_bytes: 1_048_576,
    });
  });

  test("an unknown key is refused rather than ignored", () => {
    expect(
      refuses({ base_url: "https://host/v1", model: "m", timeout: 10 }),
    ).toContain("ports.llm.timeout is not a known key");
  });

  test("a pasted key is refused without echoing it", () => {
    const message = refuses({
      base_url: "https://host/v1",
      model: "m",
      secret_ref: "sk-live-abcdefg",
    });
    expect(message).toContain("secret reference");
    expect(message).not.toContain("sk-live-abcdefg");
  });

  test("a secret reference must be resolvable, and is never echoed", () => {
    // Regression: the grammar accepted any non-whitespace tail, so a relative
    // path and a name that is not an environment variable both passed while
    // the message and the README promised otherwise.
    for (const secret_ref of [
      "file:relative-key",
      "file:../../etc/passwd",
      "env:9-not-a-name",
      "env:PATH=x",
    ]) {
      const message = refuses({
        base_url: "https://host/v1",
        model: "m",
        secret_ref,
      });
      expect(message).toContain("ports.llm.secret_ref");
      expect(message).not.toContain(secret_ref.split(":")[1] ?? "");
    }
    for (const secret_ref of ["file:/etc/kizuki/key", "env:KIZUKI_MODEL_KEY"]) {
      expect(
        readLlmPortConfig({ base_url: "https://host/v1", model: "m", secret_ref })
          .secret_ref,
      ).toBe(secret_ref);
    }
  });

  test("plain http is refused unless the endpoint is on loopback", () => {
    expect(refuses({ base_url: "http://example.test/v1", model: "m" })).toContain(
      "must use https",
    );
    expect(
      readLlmPortConfig({ base_url: "http://127.0.0.1:9/v1", model: "m" })
        .base_url,
    ).toBe("http://127.0.0.1:9/v1");
  });

  test("userinfo, queries and other schemes are refused", () => {
    expect(refuses({ base_url: "https://u:p@host/v1", model: "m" })).toContain(
      "userinfo",
    );
    expect(refuses({ base_url: "https://host/v1?k=1", model: "m" })).toContain(
      "query",
    );
    expect(refuses({ base_url: "file:///etc/passwd", model: "m" })).toContain(
      "scheme",
    );
  });

  test("numbers outside their range are refused", () => {
    expect(
      refuses({ base_url: "https://host/v1", model: "m", max_retries: 9 }),
    ).toContain("max_retries");
    expect(
      refuses({ base_url: "https://host/v1", model: "m", timeout_ms: 10 }),
    ).toContain("timeout_ms");
  });
});

describe("the model port", () => {
  test("its descriptor is the contract's and model_ref names no credential", () => {
    const llm = port({
      base_url: "https://host.test/v1",
      model: "wire-model",
      secret_ref: "env:KIZUKI_TEST_KEY",
    });
    expect(llm.descriptor).toEqual(OPENAI_COMPATIBLE_LLM);
    expect(llm.model_ref).toBe(
      "kizuki.llm.openai-compatible:wire-model@host.test",
    );
  });

  test("a completion round-trips through the endpoint", async () => {
    endpoint = startFakeEndpoint([{ body: chatCompletion('{"claims":[]}') }]);
    const llm = port({ base_url: `${endpoint.url}/v1`, model: "m" });
    const answer = await llm.complete(request);
    expect(answer).toEqual({
      text: '{"claims":[]}',
      model: "m",
      usage: { input_tokens: 11, output_tokens: 7 },
      attempts: 1,
    });
    expect(llm.attempts).toBe(1);
  });

  test("usage is estimated when the endpoint reports none", async () => {
    endpoint = startFakeEndpoint([
      { body: { choices: [{ message: { role: "assistant", content: "abcd" } }] } },
    ]);
    const llm = port({ base_url: `${endpoint.url}/v1`, model: "m" });
    const answer = await llm.complete(request);
    expect(answer.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
  });

  test("a tool call in the answer reaches the caller as a rejection", async () => {
    const body = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["tool_calls"] = [{ id: "c", function: {} }];
    endpoint = startFakeEndpoint([{ body }]);
    const llm = port({ base_url: `${endpoint.url}/v1`, model: "m" });
    await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmRejection);
  });

  test("the credential is resolved through the host at call time", async () => {
    endpoint = startFakeEndpoint([{}]);
    const asked: string[] = [];
    const llm = port(
      {
        base_url: `${endpoint.url}/v1`,
        model: "m",
        secret_ref: "env:KIZUKI_TEST_KEY",
      },
      {},
      async (ref) => {
        asked.push(ref);
        return "resolved-key";
      },
    );
    await llm.complete(request);
    expect(asked).toEqual(["env:KIZUKI_TEST_KEY"]);
    expect(endpoint.requests[0]?.headers["authorization"]).toBe(
      "Bearer resolved-key",
    );
  });

  test("an unresolvable credential fails closed before the request", async () => {
    endpoint = startFakeEndpoint([{}]);
    const llm = port(
      {
        base_url: `${endpoint.url}/v1`,
        model: "m",
        secret_ref: "env:KIZUKI_TEST_KEY",
      },
      {},
      async () => {
        throw new Error("not set");
      },
    );
    await expect(llm.complete(request)).rejects.toBeInstanceOf(PortError);
    expect(endpoint.requests).toHaveLength(0);
    expect(await llm.health()).toEqual({
      status: "unavailable",
      reason: "the configured model credential could not be resolved",
    });
  });

  test("health reports the endpoint without the credential", async () => {
    const llm = port({ base_url: "https://host.test/v1", model: "m" });
    expect(await llm.health()).toEqual({
      status: "ready",
      detail: { host: "host.test", model: "m", authenticated: false },
    });
  });

  test("a closed port refuses to complete", async () => {
    const llm = port({ base_url: "https://host.test/v1", model: "m" });
    await llm.close();
    await expect(llm.complete(request)).rejects.toBeInstanceOf(PortError);
    expect(await llm.health()).toMatchObject({ status: "unavailable" });
  });
});

describe("bounds on a call", () => {
  function counting(results: TransportResult[]): {
    transport: ChatTransport;
    calls: () => number;
  } {
    let index = 0;
    return {
      calls: () => index,
      transport: async () => {
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result === undefined) throw new Error("no scripted result");
        return result;
      },
    };
  }

  const slept: number[] = [];
  const clock: Clock = {
    now: () => 1_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };

  test("a retried call never exceeds one plus max_retries attempts", async () => {
    slept.length = 0;
    const scripted = counting([
      { ok: false, status: 429, retry_after_ms: 1 },
    ]);
    const llm = port(
      { base_url: "https://host.test/v1", model: "m", max_retries: 1 },
      { transport: scripted.transport, clock },
    );
    await expect(llm.complete(request)).rejects.toBeInstanceOf(PortError);
    // Regression: the retry used to run without checking any bound, so a run
    // could put more requests on the wire than the owner had allowed.
    expect(scripted.calls()).toBe(2);
    expect(llm.attempts).toBe(2);
  });

  test("a call never runs past the deadline it was given", async () => {
    const granted: number[] = [];
    const waited: number[] = [];
    let now = 0;
    const advancing: Clock = {
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      },
    };
    // The endpoint burns every millisecond it is granted, then asks for more.
    const transport: ChatTransport = async (_request, opts) => {
      granted.push(opts.timeout_ms);
      now += opts.timeout_ms;
      return { ok: false, status: 503, retry_after_ms: 30_000 };
    };
    const llm = port(
      { base_url: "https://host.test/v1", model: "m", max_retries: 5 },
      { transport, clock: advancing },
    );
    await expect(
      llm.complete({ ...request, deadline_ms: 60_000 }),
    ).rejects.toBeInstanceOf(PortError);
    // Regression: the deadline was applied per attempt, so a caller asking
    // for a minute could be parked for the retry count times that, plus the
    // backoff, which no scheduler can plan against.
    const spent =
      granted.reduce((total, ms) => total + ms, 0) +
      waited.reduce((total, ms) => total + ms, 0);
    expect(spent).toBeLessThanOrEqual(60_000);
    expect(now).toBeLessThanOrEqual(60_000);
  });

  test("a status that is not retryable is not retried", async () => {
    const scripted = counting([{ ok: false, status: 400, retry_after_ms: null }]);
    const llm = port(
      { base_url: "https://host.test/v1", model: "m", max_retries: 3 },
      { transport: scripted.transport, clock },
    );
    await expect(llm.complete(request)).rejects.toBeInstanceOf(PortError);
    expect(scripted.calls()).toBe(1);
  });

  test("a backward clock step never parks a run past the window", async () => {
    slept.length = 0;
    let now = 10_000_000;
    const stepping: Clock = {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    const scripted = counting([
      { ok: true, status: 200, body: chatCompletion("{}") },
    ]);
    const llm = port(
      {
        base_url: "https://host.test/v1",
        model: "m",
        requests_per_minute: 1,
      },
      { transport: scripted.transport, clock: stepping },
    );
    await llm.complete(request);
    // An NTP correction or a resume from suspend can move the clock back.
    now -= 3_600_000;
    await llm.complete({ ...request, deadline_ms: 120_000 });
    expect(Math.max(...slept)).toBeLessThanOrEqual(60_000);
  });

  test("concurrent calls cannot outrun the configured rate", async () => {
    let now = 0;
    // A real tick before the clock moves, so a call already past the gate
    // reaches the transport at the time its slot was granted rather than at
    // whatever a later call has since advanced the clock to.
    const advancing: Clock = {
      now: () => now,
      sleep: async (ms) => {
        await Bun.sleep(1);
        now += ms;
      },
    };
    const served: number[] = [];
    const transport: ChatTransport = async () => {
      served.push(now);
      return { ok: true, status: 200, body: chatCompletion("{}") };
    };
    const llm = port(
      {
        base_url: "https://host.test/v1",
        model: "m",
        requests_per_minute: 1,
      },
      { transport, clock: advancing },
    );
    await Promise.all(
      Array.from({ length: 5 }, () =>
        llm.complete({ ...request, deadline_ms: 600_000 }),
      ),
    );
    // Regression: the window check and the slot it takes straddled two
    // awaits, so five concurrent calls on one bound port all passed the same
    // check before any of them had recorded a request, and the configured
    // rate bounded nothing.
    expect(served).toHaveLength(5);
    for (let index = 1; index < served.length; index += 1) {
      expect((served[index] ?? 0) - (served[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        60_000,
      );
    }
  });

  test("a slot is given back when the credential cannot be resolved", async () => {
    const scripted = counting([
      { ok: true, status: 200, body: chatCompletion("{}") },
    ]);
    let resolvable = false;
    const llm = port(
      {
        base_url: "https://host.test/v1",
        model: "m",
        requests_per_minute: 1,
        secret_ref: "env:KIZUKI_TEST_KEY",
      },
      { transport: scripted.transport, clock },
      async () => {
        if (!resolvable) throw new Error("not set");
        return "resolved-key";
      },
    );
    await expect(llm.complete(request)).rejects.toBeInstanceOf(PortError);
    resolvable = true;
    // A request that failed closed never happened, so the call after it must
    // not be made to wait out a window for a slot nobody used.
    await llm.complete(request);
    expect(scripted.calls()).toBe(1);
  });

  test("a request outside its bounds is refused before the wire", async () => {
    const scripted = counting([
      { ok: true, status: 200, body: chatCompletion("{}") },
    ]);
    const llm = port(
      { base_url: "https://host.test/v1", model: "m" },
      { transport: scripted.transport, clock },
    );
    await expect(
      llm.complete({ ...request, messages: [] }),
    ).rejects.toBeInstanceOf(PortError);
    await expect(
      llm.complete({ ...request, max_output_tokens: 0 }),
    ).rejects.toBeInstanceOf(PortError);
    await expect(
      llm.complete({ ...request, deadline_ms: 900_000 }),
    ).rejects.toBeInstanceOf(PortError);
    expect(scripted.calls()).toBe(0);
  });
});
