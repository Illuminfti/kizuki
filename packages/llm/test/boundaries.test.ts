import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

function tracked(pathspec: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", pathspec],
    cwd: repoRoot,
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.endsWith(".ts"));
}

function importers(pathspec: string, moduleName: string): string[] {
  return tracked(pathspec).filter((file) =>
    readFileSync(join(repoRoot, file), "utf8").includes(moduleName),
  );
}

describe("package boundaries", () => {
  test("core cannot reach the network package, so it cannot reach the network", () => {
    expect(importers("packages/core/src", "@kizuki/llm")).toEqual([]);
  });

  test("the network package depends on core and nothing else", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/llm/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: unknown };
    expect(manifest.dependencies).toEqual({ "@kizuki/core": "workspace:*" });
    expect(manifest.devDependencies).toBeUndefined();
  });

  test("it does not reach sideways into the other packages", () => {
    for (const other of ["@kizuki/cli", "@kizuki/connectors", "@kizuki/tui"]) {
      expect(importers("packages/llm/src", other)).toEqual([]);
    }
  });
});
