import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  OPENAI_COMPATIBLE_LLM_ID,
  createOpenAiCompatibleLlmPort,
  parseOpenAiCompatibleConfig,
} from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { SAMPLE_REQUEST, temporaryLlmContext } from "./helpers";

const base = { base_url: "http://127.0.0.1:9/v1", model: "synthetic" };
const provider = (table: unknown) => parseOpenAiCompatibleConfig({ ...base, provider: table });
const refused = (table: unknown, message: string) =>
  expect(() => provider(table)).toThrow(new PortError("config_invalid", message, false));

let fake: FakeEndpoint | undefined;
afterEach(() => {
  fake?.stop();
  fake = undefined;
});

describe("[ports.llm.provider]", () => {
  test("accepts the allow-listed privacy controls and re-parses its own output", () => {
    const parsed = provider({
      data_collection: "deny", zdr: true, allow_fallbacks: false,
      order: ["anthropic", "openai"], only: ["anthropic"], ignore: ["deepinfra/turbo"],
    });
    expect(parsed.provider).toEqual({
      data_collection: "deny", zdr: true, allow_fallbacks: false,
      order: ["anthropic", "openai"], only: ["anthropic"], ignore: ["deepinfra/turbo"],
    });
    expect(parseOpenAiCompatibleConfig({ ...parsed })).toEqual(parsed);
  });

  test("absence and an empty table both leave the config without a provider", () => {
    expect(parseOpenAiCompatibleConfig(base)).not.toHaveProperty("provider");
    expect(provider({})).not.toHaveProperty("provider");
  });

  test("refuses unknown keys, wrong types and malformed lists", () => {
    refused({ data_colection: "deny" }, "unknown provider key data_colection");
    refused({ sort: "price" }, "unknown provider key sort");
    refused({ data_collection: "maybe" }, "provider.data_collection must be allow or deny");
    refused({ data_collection: true }, "provider.data_collection must be allow or deny");
    refused({ zdr: "yes" }, "provider.zdr must be a boolean");
    refused({ allow_fallbacks: 1 }, "provider.allow_fallbacks must be a boolean");
    for (const key of ["order", "only", "ignore"]) {
      refused({ [key]: "anthropic" }, `provider.${key} must be a list of provider names`);
      refused({ [key]: [] }, `provider.${key} must be a list of provider names`);
      refused({ [key]: [""] }, `provider.${key} must be a list of provider names`);
      refused({ [key]: ["ok", 3] }, `provider.${key} must be a list of provider names`);
      refused({ [key]: ["has space"] }, `provider.${key} must be a list of provider names`);
      refused({ [key]: Array.from({ length: 33 }, (_, index) => `p${index}`) }, `provider.${key} must be a list of provider names`);
    }
    for (const bad of ["deny", ["deny"], 1, true, null]) refused(bad, "provider must be a table");
  });

  test("is sent to the endpoint as the provider object, and only when configured", async () => {
    fake = startFakeEndpoint();
    const bodies: unknown[] = [];
    for (const extra of [{}, { provider: { data_collection: "deny", zdr: true, ignore: ["deepinfra"] } }]) {
      const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, { base_url: fake.base_url, model: "synthetic", ...extra });
      try {
        await createOpenAiCompatibleLlmPort(temporary.ctx).complete(SAMPLE_REQUEST);
        bodies.push(fake.requests.at(-1)?.body);
      } finally {
        temporary.cleanup();
      }
    }
    expect(bodies[0]).not.toHaveProperty("provider");
    expect(bodies[1]).toMatchObject({ model: "synthetic", provider: { data_collection: "deny", zdr: true, ignore: ["deepinfra"] } });
  });

  test("does not change the model identity that source consent names", () => {
    const refs: (string | null)[] = [];
    for (const extra of [{}, { provider: { data_collection: "deny", zdr: true } }, { provider: { data_collection: "allow" } }]) {
      const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, { ...base, ...extra });
      try {
        refs.push(createOpenAiCompatibleLlmPort(temporary.ctx).model_ref);
      } finally {
        temporary.cleanup();
      }
    }
    expect(new Set(refs)).toEqual(new Set([`${OPENAI_COMPATIBLE_LLM_ID}:synthetic@127.0.0.1`]));
  });
});
