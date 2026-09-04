import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  OPENAI_COMPATIBLE_LLM_ID,
  createOpenAiCompatibleLlmPort,
  parseOpenAiCompatibleConfig,
} from "../src/index";
import type { ChatTransport, TransportResult } from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import {
  CANARY_KEY,
  SAMPLE_REQUEST,
  SYNTHETIC_TEXT,
  temporaryLlmContext,
} from "./helpers";

describe("openai-compatible config", () => {
  test("accepts the RFC 0002 keys and defaults", () => {
    expect(
      parseOpenAiCompatibleConfig({
        base_url: "http://127.0.0.1:11434/v1/",
        model: "synthetic",
        secret_ref: "env:KIZUKI_MODEL_KEY",
      }),
    ).toEqual({
      base_url: "http://127.0.0.1:11434/v1",
      model: "synthetic",
      secret_ref: "env:KIZUKI_MODEL_KEY",
      timeout_ms: 60_000,
      max_retries: 2,
    });
  });

  test("refuses a plaintext key without echoing it", () => {
    let thrown: unknown;
    try {
      parseOpenAiCompatibleConfig({
        base_url: "http://127.0.0.1:9/v1",
        model: "synthetic",
        secret_ref: CANARY_KEY,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortError);
    expect((thrown as PortError).code).toBe("config_invalid");
    expect((thrown as PortError).message).not.toContain(CANARY_KEY);
  });

  test("refuses userinfo, query, fragment, and unknown keys", () => {
    expect(() =>
      parseOpenAiCompatibleConfig({
        base_url: "http://user:pass@127.0.0.1/v1",
        model: "synthetic",
      }),
    ).toThrow("userinfo");
    expect(() =>
      parseOpenAiCompatibleConfig({
        base_url: "http://127.0.0.1/v1?q=1",
        model: "synthetic",
      }),
    ).toThrow("query or fragment");
    expect(() =>
      parseOpenAiCompatibleConfig({
        base_url: "ftp://127.0.0.1/v1",
        model: "synthetic",
      }),
    ).toThrow("http or https");
    expect(() =>
      parseOpenAiCompatibleConfig({
        base_url: "http://127.0.0.1/v1",
        model: "synthetic",
        temperature: 0,
      }),
    ).toThrow("unknown llm config key temperature");
  });
});

describe("openai-compatible port", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("resolves secret_ref at call time and never logs the canary", async () => {
    let resolved = 0;
    fake = startFakeEndpoint();
    const temporary = temporaryLlmContext(
      OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
      {
        base_url: fake.base_url,
        model: "synthetic",
        secret_ref: "env:KIZUKI_MODEL_KEY",
      },
      async (ref) => {
        resolved += 1;
        expect(ref).toBe("env:KIZUKI_MODEL_KEY");
        return CANARY_KEY;
      },
    );
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      expect(resolved).toBe(0);
      const response = await port.complete(SAMPLE_REQUEST);
      expect(response.text).toBe(SYNTHETIC_TEXT);
      expect(resolved).toBe(1);
      expect(fake.requests[0]?.headers["authorization"]).toBe(
        `Bearer ${CANARY_KEY}`,
      );
      expect(port.descriptor.id).toBe(OPENAI_COMPATIBLE_LLM_ID);
    } finally {
      temporary.cleanup();
    }
  });

  test("fails closed before fetch when the secret cannot be resolved", async () => {
    let fetched = 0;
    const transport: ChatTransport = async () => {
      fetched += 1;
      return { ok: true, kind: "ok", status: 200, body: {} };
    };
    const temporary = temporaryLlmContext(
      OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
      {
        base_url: "http://127.0.0.1:9/v1",
        model: "synthetic",
        secret_ref: "env:KIZUKI_MODEL_KEY",
      },
      async () => {
        throw new PortError("unavailable", "secret reference did not resolve", false);
      },
    );
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx, { transport });
      await expect(port.complete(SAMPLE_REQUEST)).rejects.toMatchObject({
        name: "PortError",
        code: "unavailable",
        message: "secret reference did not resolve",
      });
      expect(fetched).toBe(0);
    } finally {
      temporary.cleanup();
    }
  });

  test("retries a 429 once and then succeeds", async () => {
    const calls: number[] = [];
    const transport: ChatTransport = async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        return { ok: false, kind: "http", status: 429, retry_after_ms: 1 };
      }
      return {
        ok: true,
        kind: "ok",
        status: 200,
        body: {
          model: "synthetic",
          choices: [
            { message: { role: "assistant", content: SYNTHETIC_TEXT } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      };
    };
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: "http://127.0.0.1:9/v1",
      model: "synthetic",
      max_retries: 2,
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx, { transport });
      const response = await port.complete(SAMPLE_REQUEST);
      expect(response.text).toBe(SYNTHETIC_TEXT);
      expect(calls).toHaveLength(2);
    } finally {
      temporary.cleanup();
    }
  });

  test("uses one deadline across retries and retry waits", async () => {
    fake = startFakeEndpoint(
      () => new Response("busy", { status: 429, headers: { "retry-after": "1" } }),
    );
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: fake.base_url,
      model: "synthetic",
      max_retries: 2,
      timeout_ms: 1_000,
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      const started = Date.now();
      await expect(port.complete({ ...SAMPLE_REQUEST, deadline_ms: 80 })).rejects.toMatchObject({ code: "timeout" });
      expect(Date.now() - started).toBeLessThan(300);
      expect(fake.requests).toHaveLength(1);
    } finally {
      temporary.cleanup();
    }
  });

  test("a 401 is unavailable and does not retry", async () => {
    let calls = 0;
    const transport: ChatTransport = async () => {
      calls += 1;
      return { ok: false, kind: "http", status: 401, retry_after_ms: null };
    };
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: "http://127.0.0.1:9/v1",
      model: "synthetic",
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx, { transport });
      await expect(port.complete(SAMPLE_REQUEST)).rejects.toMatchObject({
        code: "unavailable",
        message: "http 401",
      });
      expect(calls).toBe(1);
    } finally {
      temporary.cleanup();
    }
  });

  test("empty messages fail closed without a transport call", async () => {
    let calls = 0;
    const transport: ChatTransport = async (): Promise<TransportResult> => {
      calls += 1;
      return { ok: false, kind: "transport", status: 0, failure: "network" };
    };
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: "http://127.0.0.1:9/v1",
      model: "synthetic",
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx, { transport });
      await expect(
        port.complete({ ...SAMPLE_REQUEST, messages: [] }),
      ).rejects.toMatchObject({
        code: "config_invalid",
      });
      expect(calls).toBe(0);
    } finally {
      temporary.cleanup();
    }
  });
});
