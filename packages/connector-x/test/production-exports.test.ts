import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as production from "../src";
import * as testkit from "../src/testkit";

test("production exports exclude fixture source and mutation helpers", () => {
  expect("writeFixtureArchive" in production).toBe(false);
  expect("FIXTURE_TWEETS_SOURCE" in production).toBe(false);
  expect(typeof testkit.writeFixtureArchive).toBe("function");
  expect(typeof testkit.FIXTURE_TWEETS_SOURCE).toBe("string");
});

test("production source has no registry cycle or network implementation", async () => {
  const sourceRoot = path.resolve(import.meta.dir, "../src");
  const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts"));
  const source = (await Promise.all(files.map((name) => readFile(path.join(sourceRoot, name), "utf8")))).join("\n");
  expect(source).not.toContain('from "@kizuki/connectors');
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("Bun.serve");
});
