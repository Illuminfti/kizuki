import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LLM_CONFIG_DEFAULTS,
  LLM_CONFIG_PATH,
  endpointHost,
  isLoopbackUrl,
  parseLlmConfig,
  readLlmConfig,
  removeLlmConfig,
  serializeLlmConfig,
  writeLlmConfig,
} from "../src/config";
import type { LlmConfig } from "../src/config";
import { LlmError } from "../src/errors";
import { tempVault } from "./helpers";

const MINIMAL = 'base_url = "http://127.0.0.1:11434/v1/"\nmodel = "local-model"\n';
const CANARY = "sk-canary-7f3a9c";

function failure(text: string): LlmError {
  try {
    parseLlmConfig(text);
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error("expected parseLlmConfig to throw");
}

function full(): LlmConfig {
  return {
    base_url: "https://example.invalid:8443/v1",
    model: "remote-model",
    api_key_ref: "env:KIZUKI_LLM_API_KEY",
    allow_cloud_inference: true,
    sensitivity_ceiling: "private",
    unlabeled: "send",
    json_mode: false,
    temperature: 0.7,
    timeout_ms: 1000,
    requests_per_minute: 600,
    max_requests: 3,
    max_input_chars: 1234,
    max_event_chars: 99,
    max_output_tokens: 42,
    summary_min_chars: 0,
  };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function vault(): string {
  const created = tempVault();
  disposers.push(created.dispose);
  return created.path;
}

describe("parseLlmConfig", () => {
  test("applies the documented defaults and trims the trailing slash", () => {
    expect(parseLlmConfig(MINIMAL)).toEqual({
      base_url: "http://127.0.0.1:11434/v1",
      model: "local-model",
      api_key_ref: null,
      ...LLM_CONFIG_DEFAULTS,
    });
  });

  test("round-trips through serializeLlmConfig", () => {
    const config = full();
    expect(parseLlmConfig(serializeLlmConfig(config))).toEqual(config);
    const minimal = parseLlmConfig(MINIMAL);
    expect(parseLlmConfig(serializeLlmConfig(minimal))).toEqual(minimal);
  });

  test("serializes keys in the documented order and omits an absent api_key", () => {
    const keys = serializeLlmConfig(full())
      .trim()
      .split("\n")
      .map((line) => line.split(" = ")[0]);
    expect(keys).toEqual([
      "base_url",
      "model",
      "api_key",
      "allow_cloud_inference",
      "sensitivity_ceiling",
      "unlabeled",
      "json_mode",
      "temperature",
      "timeout_ms",
      "requests_per_minute",
      "max_requests",
      "max_input_chars",
      "max_event_chars",
      "max_output_tokens",
      "summary_min_chars",
    ]);
    expect(serializeLlmConfig(parseLlmConfig(MINIMAL))).not.toContain("api_key");
  });

  test("refuses an unknown key by name", () => {
    const error = failure(`${MINIMAL}colour = "blue"\n`);
    expect(error.code).toBe("unknown_key");
    expect(error.message).toContain("colour");
  });

  test("refuses a table", () => {
    const error = failure(`${MINIMAL}[extra]\nk = 1\n`);
    expect(error.code).toBe("unknown_key");
    expect(error.message).toContain("extra");
  });

  test("reports invalid TOML as malformed", () => {
    expect(failure("base_url = \n").code).toBe("malformed_config");
  });

  test.each([
    ["temperature", "-0.1"],
    ["temperature", "2.1"],
    ["temperature", '"1"'],
    ["timeout_ms", "999"],
    ["timeout_ms", "600001"],
    ["timeout_ms", "1000.5"],
    ["requests_per_minute", "0"],
    ["requests_per_minute", "601"],
    ["max_requests", "0"],
    ["max_requests", "10001"],
    ["max_input_chars", "0"],
    ["max_event_chars", "0"],
    ["max_output_tokens", "0"],
    ["summary_min_chars", "-1"],
    ["json_mode", "1"],
    ["allow_cloud_inference", '"yes"'],
    ["sensitivity_ceiling", '"secret"'],
    ["sensitivity_ceiling", '"Personal"'],
    ["unlabeled", '"maybe"'],
  ])("refuses %s = %s as bad_value", (key, literal) => {
    const error = failure(`${MINIMAL}${key} = ${literal}\n`);
    expect(error.code).toBe("bad_value");
    expect(error.message.startsWith(`${key}:`)).toBe(true);
  });

  test.each([
    ["temperature", "2", 2],
    ["temperature", "0", 0],
    ["timeout_ms", "1000", 1000],
    ["timeout_ms", "600000", 600000],
    ["requests_per_minute", "1", 1],
    ["requests_per_minute", "600", 600],
    ["max_requests", "10000", 10000],
    ["summary_min_chars", "0", 0],
  ])("accepts %s = %s at the bound", (key, literal, value) => {
    const config = parseLlmConfig(`${MINIMAL}${key} = ${literal}\n`);
    expect(config[key as keyof typeof config]).toBe(value);
  });

  test.each([
    ["3"],
    ['""'],
    ['["m"]'],
  ])("refuses model = %s", (literal) => {
    const error = failure(
      `base_url = "http://127.0.0.1/v1"\nmodel = ${literal}\n`,
    );
    expect(error.code).toBe("bad_value");
    expect(error.message.startsWith("model:")).toBe(true);
  });

  test.each([
    ['"ftp://127.0.0.1/v1"'],
    ['"http://ada:secret@127.0.0.1/v1"'],
    ['"http://127.0.0.1/v1?q=1"'],
    ['"http://127.0.0.1/v1#f"'],
    ['"not a url"'],
    ['"127.0.0.1:11434"'],
    ["42"],
  ])("refuses base_url = %s", (literal) => {
    const error = failure(`base_url = ${literal}\nmodel = "m"\n`);
    expect(error.code).toBe("bad_base_url");
  });

  test("a missing base_url is bad_base_url", () => {
    expect(failure('model = "m"\n').code).toBe("bad_base_url");
  });

  test.each([
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1/v1", true],
    ["http://127.1.2.3:8080/v1", true],
    ["http://[::1]:11434/v1", true],
    ["http://10.0.0.1/v1", false],
    ["https://example.invalid/v1", false],
    ["http://127.0.0.1.example.invalid/v1", false],
    ["garbage", false],
  ])("isLoopbackUrl(%s) is %p", (url, loopback) => {
    expect(isLoopbackUrl(url)).toBe(loopback);
  });

  test("a non-loopback host needs allow_cloud_inference", () => {
    const error = failure('base_url = "http://example.invalid/v1"\nmodel = "m"\n');
    expect(error.code).toBe("cloud_not_allowed");
    expect(error.message).toContain("example.invalid");
    expect(error.message).toContain("allow_cloud_inference = true");
  });

  test("a non-loopback http host is refused even when cloud is allowed", () => {
    const error = failure(
      'base_url = "http://example.invalid/v1"\nmodel = "m"\nallow_cloud_inference = true\n',
    );
    expect(error.code).toBe("insecure_remote");
    expect(error.message).toContain("example.invalid");
    expect(error.message).toContain("https");
  });

  test("a non-loopback https host is accepted when cloud is allowed", () => {
    const config = parseLlmConfig(
      'base_url = "https://example.invalid/v1"\nmodel = "m"\nallow_cloud_inference = true\n',
    );
    expect(config.base_url).toBe("https://example.invalid/v1");
    expect(endpointHost(config.base_url)).toBe("example.invalid");
    expect(endpointHost("https://example.invalid:8443/v1")).toBe(
      "example.invalid:8443",
    );
  });

  test("a plaintext api_key is refused and never echoed", () => {
    const error = failure(`${MINIMAL}api_key = "${CANARY}"\n`);
    expect(error.code).toBe("plaintext_key");
    expect(error.message).not.toContain(CANARY);
    expect(failure(`${MINIMAL}api_key = 12\n`).code).toBe("plaintext_key");
  });

  test("a relative file: reference is bad_secret_ref; an absolute one is kept", () => {
    expect(failure(`${MINIMAL}api_key = "file:relative/key"\n`).code).toBe(
      "bad_secret_ref",
    );
    expect(parseLlmConfig(`${MINIMAL}api_key = "file:/abs/key"\n`).api_key_ref).toBe(
      "file:/abs/key",
    );
  });
});

describe("llm.toml on disk", () => {
  test("writes an owner-only file atomically and reads it back", () => {
    const vaultPath = vault();
    const config = parseLlmConfig(MINIMAL);
    const written = writeLlmConfig(vaultPath, config);
    expect(written).toBe(join(vaultPath, LLM_CONFIG_PATH));
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(vaultPath, ".kizuki")).filter((n) => n.includes("llm")))
      .toEqual(["llm.toml"]);
    expect(readLlmConfig(vaultPath)).toEqual(config);

    writeLlmConfig(vaultPath, { ...config, model: "second" });
    expect(readLlmConfig(vaultPath)?.model).toBe("second");
    expect(readdirSync(join(vaultPath, ".kizuki")).filter((n) => n.includes("llm")))
      .toEqual(["llm.toml"]);
  });

  test("an absent file reads as null and removal reports whether a file existed", () => {
    const vaultPath = vault();
    expect(readLlmConfig(vaultPath)).toBeNull();
    expect(removeLlmConfig(vaultPath)).toBe(false);
    writeLlmConfig(vaultPath, parseLlmConfig(MINIMAL));
    expect(removeLlmConfig(vaultPath)).toBe(true);
    expect(removeLlmConfig(vaultPath)).toBe(false);
    expect(readLlmConfig(vaultPath)).toBeNull();
  });

  test("refuses to persist an invalid config and leaves the previous file untouched", () => {
    const vaultPath = vault();
    const invalid = { ...parseLlmConfig(MINIMAL), base_url: "http://example.invalid/v1" };
    expect(() => writeLlmConfig(vaultPath, invalid)).toThrow(LlmError);
    expect(existsSync(join(vaultPath, LLM_CONFIG_PATH))).toBe(false);

    const path = writeLlmConfig(vaultPath, parseLlmConfig(MINIMAL));
    const before = readFileSync(path);
    expect(() => writeLlmConfig(vaultPath, invalid)).toThrow(LlmError);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(vaultPath, ".kizuki")).filter((n) => n.includes("llm")))
      .toEqual(["llm.toml"]);
  });
});
