import { describe, expect, test } from "bun:test";
import {
  HEALTH_STATES,
  HealthReport,
  isHealthState,
} from "../src/contracts/connector";
import type {
  Connector,
  HealthState,
  Manifest,
  SyncBatch,
} from "../src/contracts/connector";
import { validEvent } from "./fixtures";

describe("HEALTH_STATES", () => {
  test("names seven states", () => {
    expect(HEALTH_STATES).toHaveLength(7);
    expect(new Set(HEALTH_STATES).size).toBe(7);
  });

  test("isHealthState guards the enum", () => {
    expect(isHealthState("ok")).toBe(true);
    expect(isHealthState("fine")).toBe(false);
    expect(isHealthState(undefined)).toBe(false);
  });
});

describe("HealthReport", () => {
  for (const state of HEALTH_STATES) {
    test(`constructs the ${state} state`, () => {
      const report = new HealthReport({
        state,
        checked_at: "2026-03-01T09:00:00Z",
      });
      expect(report.state).toBe(state);
      expect(report.detail).toBeUndefined();
    });
  }

  test("keeps detail and last_success_at", () => {
    const report = new HealthReport({
      state: "rate_limited",
      checked_at: "2026-03-01T09:00:00Z",
      detail: "retry after 60s",
      last_success_at: "2026-03-01T08:00:00Z",
    });
    expect(report.detail).toBe("retry after 60s");
    expect(report.last_success_at).toBe("2026-03-01T08:00:00Z");
  });

  const badStates: unknown[] = ["healthy", "OK", "", null, undefined, 1, {}];
  for (const state of badStates) {
    test(`throws on the invalid state ${JSON.stringify(state)}`, () => {
      expect(
        () =>
          new HealthReport({
            state: state as HealthState,
            checked_at: "2026-03-01T09:00:00Z",
          }),
      ).toThrow(TypeError);
    });
  }

  test("throws on a malformed checked_at", () => {
    expect(
      () =>
        new HealthReport({ state: "ok", checked_at: "2026-02-30T00:00:00Z" }),
    ).toThrow(TypeError);
  });

  test("throws on a malformed last_success_at", () => {
    expect(
      () =>
        new HealthReport({
          state: "ok",
          checked_at: "2026-03-01T09:00:00Z",
          last_success_at: "recently",
        }),
    ).toThrow(TypeError);
  });

  test("names the legal states in the error message", () => {
    expect(
      () =>
        new HealthReport({
          state: "wat" as HealthState,
          checked_at: "2026-03-01T09:00:00Z",
        }),
    ).toThrow(/unauthenticated/);
  });
});

describe("Connector shape", () => {
  const manifest: Manifest = {
    schema: "kizuki.connector/v1",
    connector_id: "fixture",
    version: "0.1.0",
    kinds: ["message"],
    capabilities: {
      backfill: true,
      sync: true,
      tombstones: true,
      purge: true,
      fixture: true,
    },
    required_secrets: ["env:FIXTURE_TOKEN"],
    emits_sensitivity_hint: true,
  };

  const empty: SyncBatch = { events: [], cursor: null };

  const connector: Connector = {
    manifest: () => manifest,
    health: async () =>
      new HealthReport({ state: "ok", checked_at: "2026-03-01T09:00:00Z" }),
    connect: async () => {},
    backfill: async () => ({ events: [validEvent()], cursor: "page-2" }),
    sync: async () => empty,
    revoke: async () => {},
    purgeSource: async (subject_id) => ({
      subject_id,
      source_record_ids: ["rec-1"],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [validEvent()],
  };

  test("a fixture connector satisfies the interface", async () => {
    expect(connector.manifest().connector_id).toBe("fixture");
    expect((await connector.health()).state).toBe("ok");
    expect((await connector.backfill(null)).cursor).toBe("page-2");
    expect((await connector.sync("page-2")).events).toEqual([]);
    expect(await connector.fixture()).toHaveLength(1);
  });

  test("purgeSource is keyed by subject", async () => {
    const plan = await connector.purgeSource("person:ada");
    expect(plan.subject_id).toBe("person:ada");
    expect(plan.source_record_ids).toEqual(["rec-1"]);
  });

  test("required_secrets carry secret_ref URIs, not plaintext", () => {
    for (const ref of manifest.required_secrets) {
      expect(ref).toMatch(/^(env|file):/);
    }
  });
});
