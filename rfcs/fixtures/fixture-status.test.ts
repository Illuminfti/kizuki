/** The fixture status registry is the one place a design fixture is promoted. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    if (entry.status === "executable") expect(boundTestErrors(entry.test, ROOT, unit), unit).toEqual([]);
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

test("executable is accepted only for an existing test file that names the fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-fixture-status-"));
  try {
    mkdirSync(join(root, "rfcs/fixtures"), { recursive: true });
    mkdirSync(join(root, "packages/core/test"), { recursive: true });
    writeFileSync(join(root, "rfcs/fixtures/bound.test.ts"), "// runs present-design against the product\n");
    writeFileSync(join(root, "packages/core/test/unit.test.ts"), "// runs present-design#a_one\n");
    writeFileSync(join(root, "rfcs/fixtures/unrelated.test.ts"), "// something else\n");
    writeFileSync(join(root, "README.md"), "present-design\n");
    writeFileSync(join(root, "rfcs/fixtures/fixture-status.test.ts"), "present-design\n");
    writeFileSync(join(root, "rfcs/fixtures/notes.ts"), "present-design\n");
    const registry: FixtureRegistry = {
      present: { status: "executable", test: "rfcs/fixtures/bound.test.ts" },
      "present-design": { status: "executable", test: "rfcs/fixtures/bound.test.ts" },
      "present-design#a_one": { status: "executable", test: "packages/core/test/unit.test.ts" },
      missing: { status: "executable", test: "rfcs/fixtures/no-such-file.test.ts" },
      escaping: { status: "executable", test: "../outside.test.ts" },
      absolute: { status: "executable", test: "/etc/hostname" },
      unrelated: { status: "executable", test: "rfcs/fixtures/unrelated.test.ts" },
      readme: { status: "executable", test: "README.md" },
      "not-a-test": { status: "executable", test: "rfcs/fixtures/notes.ts" },
      "present-design#self": { status: "executable", test: "rfcs/fixtures/fixture-status.test.ts" },
    };
    expect(fixtureStatusErrors("present", "future_unimplemented", registry, root)).toEqual([]);
    expect(boundTestErrors("rfcs/fixtures/bound.test.ts", root, "present-design")).toEqual([]);
    expect(boundTestErrors("packages/core/test/unit.test.ts", root, "present-design#a_one")).toEqual([]);
    for (const id of ["missing", "escaping", "absolute", "unrelated", "readme", "not-a-test", "present-design#self"]) {
      expect(fixtureStatusErrors(id, "future_unimplemented", registry, root).length, id).toBeGreaterThan(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry's own files cannot bind a fixture, even in this repository", () => {
  for (const own of ["rfcs/fixtures/fixture-status.test.ts", "rfcs/fixtures/oracle-coverage.test.ts"]) {
    expect(boundTestErrors(own, ROOT, DESIGN).length, own).toBeGreaterThan(0);
  }
});
