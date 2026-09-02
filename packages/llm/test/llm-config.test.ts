import { describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { readLlmPortConfig } from "../src/config";

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
