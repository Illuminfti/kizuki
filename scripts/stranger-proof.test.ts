import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildInfo, parseProofArgs, proofEnvironment, requireFixture, runArtifactProof } from "./stranger-proof";
import { writePackageFixture } from "./release-package-fixture";
import { checksumManifest, CURRENT_PACKAGE_FILES } from "./release-artifacts";
import { nativeReleaseTarget } from "./release-targets";
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
        schema: string;
        source_sha: string;
        binary_sha256: string;
        failures: string[];
        engine_observations: { kizuki: null; kizuki_mcp: null };
      };
      expect(receipt.schema).toBe("kizuki.artifact-proof/v2");
      expect(receipt.source_sha).toBe("unavailable");
      expect(receipt.binary_sha256).toBe("unavailable");
      expect(receipt.failures).toHaveLength(1);
      expect(receipt.failures).toEqual(["artifact-proof-failed"]);
      expect(receipt.engine_observations).toEqual({ kizuki: null, kizuki_mcp: null });
    }
  });
});


test.each(["notice", "missing-license", "extra-member"])("copied proof refuses %s before any child execution", async mutation => {
  const artifact = temporary(), report = join(temporary(), "report");
  writePackageFixture(artifact, undefined, nativeReleaseTarget().target);
  if (mutation === "notice") writeFileSync(join(artifact, "THIRD-PARTY-NOTICES.txt"), "changed notice");
  if (mutation === "missing-license") rmSync(join(artifact, "LICENSE"));
  if (mutation === "extra-member") writeFileSync(join(artifact, "extra"), "unexpected");
  await expect(runArtifactProof({ artifact, report })).rejects.toThrow("artifact proof failed");
  const receipt = JSON.parse(readFileSync(join(report, "receipt.json"), "utf8"));
  expect(receipt.steps).toEqual([]);
  expect(receipt.engine_observations).toEqual({ kizuki: null, kizuki_mcp: null });
});

test.each(["unchanged", "source", "copy"])("actual CLI/MCP proof refuses a member added after admission: %s", async mutation => {
  const artifact = temporary(), reportRoot = temporary(), report = join(reportRoot, "report"), witness = join(reportRoot, "fault-observed");
  writePackageFixture(artifact, undefined, nativeReleaseTarget().target);
  const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const mutate = mutation === "unchanged" ? "" : mutation === "source"
    ? `if [ "$1" = init ]; then printf synthetic > ${shellQuote(join(artifact, "unexpected-member"))}; fi\n`
    : 'if [ "$1" = init ]; then printf synthetic > "${0%/*}/unexpected-member" && test -f "${0%/*}/unexpected-member" && printf observed > ' + shellQuote(witness) + '; fi\n';
  // These launchers execute the real product commands; no engine response or
  // successful journey output is synthesized. The added member is the fault.
  writeFileSync(join(artifact, "kizuki"), `#!/bin/sh\n${mutate}exec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "../packages/cli/src/main.ts"))} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(artifact, "kizuki-mcp"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "../packages/mcp/src/bin.ts"))} "$@"\n`, { mode: 0o700 });
  chmodSync(join(artifact, "kizuki"), 0o700); chmodSync(join(artifact, "kizuki-mcp"), 0o700);
  writeFileSync(join(artifact, "SHA256SUMS"), checksumManifest(artifact, CURRENT_PACKAGE_FILES.slice(0, -1)));
  let failed = false;
  try { await runArtifactProof({ artifact, report }); } catch { failed = true; }
  const receipt = JSON.parse(readFileSync(join(report, "receipt.json"), "utf8"));
  expect(receipt.source_sha).toBe("a".repeat(40));
  expect(receipt.steps.find((step: StepReceipt) => step.id === "init").passed).toBe(true);
  if (mutation === "unchanged") {
    expect(failed).toBe(false); expect(receipt.failures).toEqual([]); expect(receipt.steps).toHaveLength(16);
  } else {
    expect(existsSync(mutation === "source" ? join(artifact, "unexpected-member") : witness)).toBe(true);
    expect(failed).toBe(true); expect(receipt.failures.length).toBeGreaterThan(0);
  }
}, 120_000);
