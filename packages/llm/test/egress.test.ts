import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseAllowlist,
  scanSourceText,
} from "../../../scripts/verify-network";

describe("llm egress pin", () => {
  test("packages/llm has exactly one fetch and one Bun.serve", () => {
    const tracked = Bun.spawnSync({
      cmd: ["git", "ls-files", "-z", "--", "packages/llm"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0 && /\.[cm]?[jt]sx?$/.test(file));

    const findings = files.flatMap((file) =>
      scanSourceText(file, readFileSync(file, "utf8")).map((finding) => ({
        file,
        reason: finding.reason,
      })),
    );

    expect(findings).toEqual([
      {
        file: "packages/llm/src/transport.ts",
        reason: "network API call: fetch",
      },
      {
        file: "packages/llm/test/fake-endpoint.ts",
        reason: "network API call: Bun.serve",
      },
    ]);
  });

  test("the network allowlist names both llm call sites", () => {
    const entries = parseAllowlist(
      readFileSync("scripts/network-allowlist.txt", "utf8"),
    );
    const llm = entries.filter((entry) =>
      entry.path.startsWith("packages/llm/"),
    );
    expect(llm.map((entry) => entry.path).sort()).toEqual([
      "packages/llm/src/transport.ts",
      "packages/llm/test/fake-endpoint.ts",
    ]);
    expect(llm.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});
