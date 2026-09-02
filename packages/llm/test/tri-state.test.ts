import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  NONE_LLM_DESCRIPTOR,
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  createNoneLlmPort,
  createOpenAiCompatibleLlmPort,
} from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import {
  SAMPLE_REQUEST,
  SYNTHETIC_TEXT,
  completionBody,
  temporaryLlmContext,
} from "./helpers";

describe("llm port tri-state", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("unavailable is not an empty completion", async () => {
    const noneCtx = temporaryLlmContext(NONE_LLM_DESCRIPTOR);
    const deadCtx = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: "http://127.0.0.1:9/v1",
      model: "synthetic",
      max_retries: 0,
    });
    try {
      const none = createNoneLlmPort(noneCtx.ctx);
      const dead = createOpenAiCompatibleLlmPort(deadCtx.ctx);

      const noneError = await none.complete(SAMPLE_REQUEST).then(
        () => null,
        (error: unknown) => error,
      );
      const deadError = await dead.complete(SAMPLE_REQUEST).then(
        () => null,
        (error: unknown) => error,
      );

      expect(noneError).toBeInstanceOf(PortError);
      expect((noneError as PortError).code).toBe("unavailable");
      expect(deadError).toBeInstanceOf(PortError);
      expect((deadError as PortError).code).toBe("unavailable");
      expect((deadError as PortError).retryable).toBe(true);
    } finally {
      noneCtx.cleanup();
      deadCtx.cleanup();
    }
  });

  test("a 200 with empty text is success, not unavailable", async () => {
    fake = startFakeEndpoint(() =>
      Response.json(completionBody("")),
    );
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: fake.base_url,
      model: "synthetic",
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      const response = await port.complete(SAMPLE_REQUEST);
      expect(response.text).toBe("");
      expect(response.model).toBe("synthetic");
      expect(port.model_ref).toBe(
        "kizuki.llm.openai-compatible:synthetic@127.0.0.1",
      );
    } finally {
      temporary.cleanup();
    }
  });

  test("a usable completion is a value", async () => {
    fake = startFakeEndpoint();
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: fake.base_url,
      model: "synthetic",
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      const response = await port.complete(SAMPLE_REQUEST);
      expect(response.text).toBe(SYNTHETIC_TEXT);
      expect(await port.health()).toEqual({
        status: "ready",
        detail: {
          model_ref: "kizuki.llm.openai-compatible:synthetic@127.0.0.1",
          host: "127.0.0.1",
        },
      });
    } finally {
      temporary.cleanup();
    }
  });

  test("timeout is a retryable PortError, not empty text", async () => {
    fake = startFakeEndpoint(async () => {
      await Bun.sleep(200);
      return Response.json(completionBody(SYNTHETIC_TEXT));
    });
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, {
      base_url: fake.base_url,
      model: "synthetic",
      timeout_ms: 1_000,
      max_retries: 0,
    });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      let thrown: unknown;
      try {
        await port.complete({ ...SAMPLE_REQUEST, deadline_ms: 40 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PortError);
      expect((thrown as PortError).code).toBe("timeout");
      expect((thrown as PortError).retryable).toBe(true);
    } finally {
      temporary.cleanup();
    }
  });
});
