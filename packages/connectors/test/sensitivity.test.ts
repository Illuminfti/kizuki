import { expect, test } from "bun:test";
import { resolveSensitivity as resolveCoreSensitivity } from "@kizuki/core";
import { getConnector } from "../src/registry";
import { resolveSensitivity } from "../src/sensitivity";
import type { SensitivityPolicy } from "../src/sensitivity";

const IMPORTERS = [
  ["kizuki.import-whatsapp", "private", "personal"],
  ["kizuki.import-pocket", "personal", "public"],
  ["kizuki.import-omnivore", "personal", "public"],
] as const;

const LABELS = ["public", "personal", "private"] as const;
const POLICY_VALUES = [...LABELS, undefined] as const;
const HINTS: readonly unknown[] = [...LABELS, undefined, "secret", 7];

test("every importer declares what its records are labeled", () => {
  // A source class decides the label, so the manifest carries it and a host
  // can seed a connection's policy from the manifest alone.
  for (const [id, expected, floor] of IMPORTERS) {
    const manifest = getConnector(id, { path: "/nonexistent" }).manifest();
    expect(manifest.default_sensitivity).toBe(expected);
    expect(manifest.sensitivity_floor).toBe(floor);
    expect(manifest.emits_sensitivity_hint).toBe(true);
  }
});

test("what an importer labels a record is what its manifest declared", async () => {
  for (const [id, expected] of IMPORTERS) {
    const events = await getConnector(id, { path: "/nonexistent" }).fixture();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.sensitivity_hint).toBe(expected);
    }
  }
});

test("connector resolution matches core for every default, floor and hint", () => {
  for (const default_sensitivity of POLICY_VALUES) {
    for (const sensitivity_floor of POLICY_VALUES) {
      const policy: Partial<SensitivityPolicy> = {};
      if (default_sensitivity !== undefined) {
        policy.default_sensitivity = default_sensitivity;
      }
      if (sensitivity_floor !== undefined) {
        policy.sensitivity_floor = sensitivity_floor;
      }
      for (const hint of HINTS) {
        expect(resolveSensitivity(policy, hint)).toBe(
          resolveCoreSensitivity({
            connector_floor: policy.sensitivity_floor,
            connector_default: policy.default_sensitivity,
            event_hint: hint,
          }).sensitivity,
        );
      }
    }
  }
});

test("a valid event hint can only raise the connector default", () => {
  const policy = {
    default_sensitivity: "personal",
    sensitivity_floor: "public",
  } as const;
  expect(resolveSensitivity(policy)).toBe("personal");
  expect(resolveSensitivity(policy, "private")).toBe("private");
  expect(resolveSensitivity(policy, "public")).toBe("personal");

  const chat = {
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  } as const;
  expect(resolveSensitivity(chat, "public")).toBe("private");
  expect(resolveSensitivity(chat, "personal")).toBe("private");
  expect(resolveSensitivity(chat)).toBe("private");
});

test("a label that cannot be placed is private", () => {
  // Unknown, absent or unparseable is the most sensitive answer, not the most
  // convenient one.
  expect(resolveSensitivity({}, "secret")).toBe("private");
  expect(resolveSensitivity({}, undefined)).toBe("private");
  expect(resolveSensitivity({ sensitivity_floor: "public" }, 7)).toBe(
    "private",
  );
});
