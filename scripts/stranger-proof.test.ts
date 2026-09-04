import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildInfo, parseProofArgs, proofEnvironment, requireFixture, runArtifactProof } from "./stranger-proof";
import type { StepReceipt } from "./stranger-proof";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-artifact-proof-test-"));
  directories.push(directory);
  return directory;
}

describe("artifact proof", () => {
  test("requires a retained report directory and rejects unknown arguments", () => {
    expect(() => parseProofArgs([])).toThrow("requires --report");
    expect(() => parseProofArgs(["--unexpected", "x"])).toThrow("usage:");
    expect(parseProofArgs(["--artifact", "fixture", "--report", "receipt"]).artifact).toEndWith("fixture");
  });

  test("accepts only exact build provenance", () => {
    const directory = temporary();
    const build = join(directory, "BUILD.json");
    writeFileSync(build, JSON.stringify({
      schema: "kizuki.release-build/v1",
      source_sha: "a".repeat(40),
      target: "bun-linux-x64-baseline",
      bun_version: "1.3.10",
    }));
    expect(parseBuildInfo(build).source_sha).toBe("a".repeat(40));
    writeFileSync(build, JSON.stringify({ schema: "kizuki.release-build/v1", source_sha: "a".repeat(40), target: "x", bun_version: "1.3.10", extra: true }));
    expect(() => parseBuildInfo(build)).toThrow("invalid shape");
  });

  test("creates a clean child environment without inherited Kizuki settings", () => {
    const environment = proofEnvironment(temporary());
    expect(environment.HOME).not.toBe(process.env.HOME);
    expect(environment.KIZUKI_CONFIG).toContain("config");
    expect(Object.keys(environment).sort()).toEqual(["HOME", "KIZUKI_CONFIG", "KIZUKI_SUPERVISOR", "LANG", "PATH", "XDG_CONFIG_HOME"]);
  });

  test("records semantic recall failures as failed steps", () => {
    const steps: StepReceipt[] = [];
    expect(() => requireFixture("query-result", "no match\n", steps)).toThrow("query-result");
    expect(steps).toEqual([{
      id: "query-result",
      command: ["assert", "fixture is recalled"],
      exit_code: 1,
      passed: false,
      timeout_ms: 0,
    }]);
  });

  test("writes a failure receipt for missing or malformed artifacts", async () => {
    const directory = temporary();
    for (const [name, artifact] of [
      ["missing", join(directory, "missing")],
      ["malformed", directory],
    ] as const) {
      const report = join(directory, name);
      await expect(runArtifactProof({ artifact, report })).rejects.toThrow("artifact proof failed");
      const receipt = JSON.parse(readFileSync(join(report, "receipt.json"), "utf8")) as {
        source_sha: string;
        binary_sha256: string;
        failures: string[];
      };
      expect(receipt.source_sha).toBe("unavailable");
      expect(receipt.binary_sha256).toBe("unavailable");
      expect(receipt.failures).toHaveLength(1);
    }
  });
});
