import { expect, test } from "bun:test";
import { getConnector } from "../src/registry";
import { resolveSensitivity } from "../src/sensitivity";

const IMPORTERS = [
  ["kizuki.import-whatsapp", "private", "personal"],
  ["kizuki.import-pocket", "personal", "public"],
  ["kizuki.import-omnivore", "personal", "public"],
] as const;

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

test("a source's own hint is honored only upward", () => {
  const policy = {
    default_sensitivity: "personal",
    sensitivity_floor: "public",
  } as const;
  expect(resolveSensitivity(policy)).toBe("personal");
  expect(resolveSensitivity(policy, "private")).toBe("private");
  expect(resolveSensitivity(policy, "public")).toBe("public");

  const chat = {
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  } as const;
  // Below the floor is raised to it rather than believed: a source cannot
  // talk its own records down into being served more widely.
  expect(resolveSensitivity(chat, "public")).toBe("personal");
  expect(resolveSensitivity(chat, "personal")).toBe("personal");
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
