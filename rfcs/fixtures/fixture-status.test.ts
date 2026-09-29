/** The fixture status registry is the one place a design fixture is promoted. */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_STATUS,
  ORACLE_ASSERTION_STATUS,
  WORKSTREAM_KEYS,
  boundTestErrors,
  fixtureStatusErrors,
  type FixtureRegistry,
} from "./status";

const DIRECTORY = import.meta.dir;
const ROOT = join(DIRECTORY, "../..");
const DESIGN = "world-forecast-purge-design";

function fixtureIds(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

test("every design fixture file has exactly one registry entry and none is stale", () => {
  expect(Object.keys(FIXTURE_STATUS).sort()).toEqual(fixtureIds());
});

test("a deferred entry names a known workstream owner", () => {
  for (const [id, entry] of [...Object.entries(FIXTURE_STATUS), ...Object.entries(ORACLE_ASSERTION_STATUS)]) {
    if (entry.status === "deferred") {
      expect(WORKSTREAM_KEYS as readonly string[], id).toContain(entry.owner);
    }
  }
});

test("every executable entry, fixture or assertion, names a test file that exists", () => {
  for (const [unit, entry] of [...Object.entries(FIXTURE_STATUS), ...Object.entries(ORACLE_ASSERTION_STATUS)]) {
    if (entry.status === "executable") expect(boundTestErrors(entry.test, ROOT), unit).toEqual([]);
  }
});

test("no design test or validator hard-codes the unimplemented status", () => {
  const offenders = readdirSync(DIRECTORY)
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        name !== "status.ts" &&
        name !== "fixture-status.test.ts",
    )
    .filter((name) =>
      readFileSync(join(DIRECTORY, name), "utf8").includes(
        "future_unimplemented",
      ),
    );
  expect(offenders).toEqual([]);
});

test("a deferred fixture must still declare itself unimplemented", () => {
  expect(fixtureStatusErrors(DESIGN, "future_unimplemented")).toEqual([]);
  expect(fixtureStatusErrors(DESIGN, "executable").length).toBeGreaterThan(0);
  expect(fixtureStatusErrors(DESIGN, undefined).length).toBeGreaterThan(0);
});

test("an unregistered fixture id is refused", () => {
  expect(
    fixtureStatusErrors("not-a-fixture", "future_unimplemented").length,
  ).toBeGreaterThan(0);
});

test("executable is accepted only when the registered test file exists", () => {
  const registry: FixtureRegistry = {
    present: {
      status: "executable",
      test: "rfcs/fixtures/fixture-status.test.ts",
    },
    missing: {
      status: "executable",
      test: "rfcs/fixtures/no-such-file.test.ts",
    },
    escaping: { status: "executable", test: "../outside.test.ts" },
    absolute: { status: "executable", test: "/etc/hostname" },
  };
  expect(
    fixtureStatusErrors("present", "future_unimplemented", registry, ROOT),
  ).toEqual([]);
  for (const id of ["missing", "escaping", "absolute"]) {
    expect(
      fixtureStatusErrors(id, "future_unimplemented", registry, ROOT).length,
      id,
    ).toBeGreaterThan(0);
  }
  expect(existsSync(join(ROOT, "rfcs/fixtures/no-such-file.test.ts"))).toBe(
    false,
  );
});
