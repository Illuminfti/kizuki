import { describe, expect, test } from "bun:test";
import {
  HealthReport,
  KizukiError as CoreKizukiError,
  freezeManifest,
} from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";
import type { Connector } from "@kizuki/core";
import { KizukiError } from "../src";
import { runConformance } from "../src/testkit";

function secretRequiringConnector(): Connector {
  return {
    manifest: () =>
      freezeManifest({
        schema: "kizuki.connector/v1",
        connector_id: "fixture",
        version: "1",
        contract_minor: 1,
        implementation: "@kizuki/connectors",
        allowed_egress: [],
        cursor_schema: null,
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
        default_sensitivity: "private",
        sensitivity_floor: "private",
        auth_modes: ["secret_ref"],
      }),
    health: async () =>
      new HealthReport({
        state: "unauthenticated",
        checked_at: "2026-01-01T00:00:00.000Z",
      }),
    connect: async (resolve) => {
      await resolve("env:FIXTURE_TOKEN");
    },
    backfill: async () => {
      throw new KizukiError("not_supported", "fixture: backfill", {
        retryable: false,
      });
    },
    sync: async () => {
      throw new KizukiError("not_supported", "fixture: sync", {
        retryable: false,
      });
    },
    revoke: async () => undefined,
    purgeSource: async () => {
      throw new KizukiError("not_supported", "fixture: purge", {
        retryable: false,
      });
    },
    fixture: async () => {
      throw new KizukiError("not_supported", "fixture: fixture", {
        retryable: false,
      });
    },
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
      "timeout",
      "not_supported",
      "unavailable",
      "malformed_record",
      "source_schema",
      "corrupted",
    ];
    expect(new KizukiError("timeout", "late").retryable).toBe(true);
    expect(new KizukiError("not_supported", "no").retryable).toBe(false);
    for (const code of codes) {
      expect(new KizukiError(code, code).code).toBe(code);
    }
  });

  test("the conformance fail-closed check still recognises the core class", async () => {
    const result = await runConformance(secretRequiringConnector());
    expect(result).toEqual({ pass: true, failures: [] });
  });
});
