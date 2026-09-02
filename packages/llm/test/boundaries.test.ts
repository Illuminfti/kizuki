import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

describe("llm package boundaries", () => {
  test("core source never imports @kizuki/llm", () => {
    const files = listFiles("packages/core/src").filter((file) =>
      file.endsWith(".ts"),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toContain("@kizuki/llm");
    }
  });

  test("the package depends only on @kizuki/core", () => {
    const pkg = JSON.parse(
      readFileSync("packages/llm/package.json", "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@kizuki/core": "workspace:*" });
  });

  test("llm source does not import other workspace packages or sqlite", () => {
    const files = listFiles("packages/llm/src").filter((file) =>
      file.endsWith(".ts"),
    );
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("@kizuki/cli");
      expect(source).not.toContain("@kizuki/connectors");
      expect(source).not.toContain("@kizuki/tui");
      expect(source).not.toMatch(/["']bun:sqlite["']/);
      expect(source).not.toMatch(/["'`]kizuki\.db["'`]/);
    }
  });
});
