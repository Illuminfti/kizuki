import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAllowlist, scanSourceText } from "../../../scripts/verify-network";

const repoRoot = resolve(import.meta.dir, "../../..");

function trackedFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", "packages/llm"],
    cwd: repoRoot,
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.endsWith(".ts"));
}

describe("egress surface of the llm package", () => {
  test("only the transport and the loopback fake touch the network", () => {
    const byFile = new Map<string, string[]>();
    for (const file of trackedFiles()) {
      const findings = scanSourceText(
        file,
        readFileSync(join(repoRoot, file), "utf8"),
      );
      if (findings.length > 0) {
        byFile.set(
          file,
          findings.map((finding) => finding.reason),
        );
      }
    }
    expect(Object.fromEntries(byFile)).toEqual({
      "packages/llm/src/transport.ts": ["network API call: fetch"],
      "packages/llm/test/fake-endpoint.ts": ["network API call: Bun.serve"],
    });
  });

  test("the allowlist names those two files with a reason", () => {
    const entries = parseAllowlist(
      readFileSync(join(repoRoot, "scripts/network-allowlist.txt"), "utf8"),
    );
    const own = entries.filter((entry) =>
      entry.path.startsWith("packages/llm/"),
    );
    expect(own.map((entry) => entry.path)).toEqual([
      "packages/llm/src/transport.ts",
      "packages/llm/test/fake-endpoint.ts",
    ]);
    for (const entry of own) expect(entry.reason.length).toBeGreaterThan(0);
  });
});
