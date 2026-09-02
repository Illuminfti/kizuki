import { describe, expect, test } from "bun:test";
import { KizukiError as CoreKizukiError } from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";
import type { Connector } from "@kizuki/core";
import { KizukiError, runConformance } from "../src";

function secretRequiringConnector(): Connector {
  return {
    manifest: () => ({
      schema: "kizuki.connector/v1",
      connector_id: "fixture",
      version: "1",
      kinds: ["message"],
      capabilities: {
        backfill: false,
        sync: false,
        tombstones: false,
        purge: false,
        fixture: false,
      },
      required_secrets: ["env:FIXTURE_TOKEN"],
      emits_sensitivity_hint: false,
      auth_modes: ["secret_ref"],
    }),
    health: async () => {
      throw new Error("unused");
    },
    connect: async (resolve) => {
      await resolve("env:FIXTURE_TOKEN");
    },
    backfill: async () => ({ events: [], cursor: null }),
    sync: async () => ({ events: [], cursor: null }),
    revoke: async () => undefined,
    purgeSource: async () => ({
      subject_id: "",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [],
  };
}

describe("KizukiError lives in core", () => {
  test("the connectors package re-exports the core class", () => {
    expect(KizukiError).toBe(CoreKizukiError);
  });

  test("carries a code, a message and an optional cause", () => {
    const cause = new Error("disk");
    const error = new KizukiError("misconfigured", "path missing", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("KizukiError");
    expect(error.code).toBe("misconfigured");
    expect(error.message).toBe("path missing");
    expect(error.cause).toBe(cause);
  });

  test("accepts the provider-facing codes OAuth connectors raise", () => {
    const codes: KizukiErrorCode[] = [
      "unknown_connector",
      "parse_error",
      "missing_secret",
      "misconfigured",
      "unauthenticated",
      "rate_limited",
      "unreachable",
      "provider_error",
    ];
    for (const code of codes) {
      expect(new KizukiError(code, code).code).toBe(code);
    }
  });

  test("the conformance fail-closed check still recognises the core class", async () => {
    const result = await runConformance(secretRequiringConnector());
    expect(result).toEqual({ pass: true, failures: [] });
  });
});
