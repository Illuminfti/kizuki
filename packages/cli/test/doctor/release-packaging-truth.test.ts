import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_BUILD_TIMESTAMP_EPOCH_SECONDS,
  buildMetadataDefines,
  isValidBuildTimestamp,
  packagedQuickStart,
  resolveBuildTimestamp,
} from "../../../../scripts/build-release";
import { checksumManifest, CURRENT_PACKAGE_FILES } from "../../../../scripts/release-artifacts";
import { writePackageFixture } from "../../../../scripts/release-package-fixture";
import { nativeReleaseTarget, selectedReleaseTarget } from "../../../../scripts/release-targets";
import {
  assertCleanDoctorEnvelope,
  assertNoDegradedDiagnostics,
  runArtifactProof,
  type StepReceipt,
} from "../../../../scripts/stranger-proof";

setDefaultTimeout(120_000);

const repoRoot = resolve(import.meta.dir, "../../../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporary(prefix = "kizuki-release-truth-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const VERSION_PROBE = `import { versionCommand } from ${JSON.stringify(resolve(repoRoot, "packages/cli/src/commands/version.ts"))};
const lines: string[] = [];
const code = await versionCommand.run({ out: (line: string) => lines.push(line), err: () => {} } as never, []);
process.stdout.write(lines.join("\\n") + "\\n");
process.exit(code);
`;

describe("release packaging reproducibility and timestamp contract", () => {
  test("build and smoke share the same 4-digit UTC timestamp bounds", () => {
    const sha = "a".repeat(40);
    const epochZero = resolveBuildTimestamp({ SOURCE_DATE_EPOCH: "0" }, "1700000000");
    expect(epochZero.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(isValidBuildTimestamp(epochZero.toISOString())).toBe(true);

    const sample = resolveBuildTimestamp({ SOURCE_DATE_EPOCH: "1767323045" }, "1700000000");
    expect(sample.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(isValidBuildTimestamp(sample.toISOString())).toBe(true);
    expect(resolveBuildTimestamp({}, "1767323045").toISOString()).toBe("2026-01-02T03:04:05.000Z");

    const maxValid = resolveBuildTimestamp({ SOURCE_DATE_EPOCH: String(MAX_BUILD_TIMESTAMP_EPOCH_SECONDS) });
    expect(maxValid.toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(isValidBuildTimestamp(maxValid.toISOString())).toBe(true);
    expect(buildMetadataDefines(sha, maxValid).KIZUKI_BUILD_TIME).toBe('"9999-12-31T23:59:59.000Z"');

    const firstOutOfRange = String(MAX_BUILD_TIMESTAMP_EPOCH_SECONDS + 1);
    expect(() => resolveBuildTimestamp({ SOURCE_DATE_EPOCH: firstOutOfRange })).toThrow("out of valid date range");
    expect(() => resolveBuildTimestamp({}, firstOutOfRange)).toThrow("out of range");
    expect(() => buildMetadataDefines(sha, new Date((MAX_BUILD_TIMESTAMP_EPOCH_SECONDS + 1) * 1000))).toThrow("valid build time");
    expect(() => buildMetadataDefines(sha, new Date(-1000))).toThrow("valid build time");
    expect(isValidBuildTimestamp("+010000-01-01T00:00:00.000Z")).toBe(false);
    expect(isValidBuildTimestamp("1969-12-31T23:59:59.999Z")).toBe(false);
    expect(isValidBuildTimestamp("2026-02-30T00:00:00.000Z")).toBe(false);

    for (const invalid of ["", "-1", "12.3", " 100", "abc", "0123"]) {
      expect(() => resolveBuildTimestamp({ SOURCE_DATE_EPOCH: invalid }, "1767323045")).toThrow("SOURCE_DATE_EPOCH");
      expect(() => resolveBuildTimestamp({}, invalid)).toThrow("valid source commit timestamp");
    }
  });

  test("two compiled binaries with identical resolved build metadata are byte-identical", async () => {
    const directory = temporary("kizuki-reproducible-build-");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const entrypoint = join(directory, "probe.ts");
    writeFileSync(entrypoint, VERSION_PROBE, "utf8");
    const builtAt = resolveBuildTimestamp({}, "1767323045");
    const define = { KIZUKI_COMPILED: "true", ...buildMetadataDefines(sha, builtAt) };
    const compileOnce = (slot: string): string => {
      const staging = join(directory, slot);
      mkdirSync(staging, { recursive: true });
      const binary = join(staging, "kizuki");
      const flags = Object.entries(define).flatMap(([key, value]) => ["--define", `${key}=${value}`]);
      const compiled = Bun.spawnSync([process.execPath, "build", entrypoint, "--compile", "--outfile", binary, ...flags], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (compiled.exitCode !== 0) throw new Error(`repro build failed: ${compiled.stderr.toString()}`);
      return createHash("sha256").update(readFileSync(binary)).digest("hex");
    };
    const first = compileOnce("staging-1");
    await Bun.sleep(1050);
    const second = compileOnce("staging-2");
    expect(second).toBe(first);
  });

  test("packagedQuickStart includes local PATH symlinks, PATH export, 14-tool MCP note, and clean prose", () => {
    const sha = "c".repeat(40);
    const text = packagedQuickStart({ version: "1.0.2", target: selectedReleaseTarget(), sourceSha: sha });
    expect(text).toContain('ln -sf "$PWD/kizuki" "$HOME/.local/bin/kizuki"');
    expect(text).toContain('ln -sf "$PWD/kizuki-mcp" "$HOME/.local/bin/kizuki-mcp"');
    expect(text).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(text).toContain("14 scoped tools");
    expect(text).toContain(`https://github.com/Illuminfti/kizuki/blob/${sha}/docs/integrations.md`);
    expect(text).toContain(`https://github.com/Illuminfti/kizuki/blob/${sha}/docs/upgrade.md`);
    expect(text).not.toMatch(/\/home\/|\/Users\/|\/data\//);
    expect(text).not.toContain("\u2014");
  });
});

describe("stranger-proof doctor stderr and step receipt truth", () => {
  test("assertCleanDoctorEnvelope enforces healthy doctor JSON and clean stderr", () => {
    const healthy = {
      schema: "kizuki.cli.doctor/v1",
      status: "ok",
      degraded: [] as string[],
      warnings: [] as string[],
      data: {
        ok: true,
        problems: [] as unknown[],
        ledger: { ok: true },
        serve: { ok: true, failures: [] as unknown[] },
      },
    };
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0)).not.toThrow();
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "")).not.toThrow();
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "degraded=index-behind-ledger\n")).toThrow("doctor-degraded");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "unexpected warning\n")).toThrow("doctor-stderr");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, degraded: ["index-behind-ledger"] }), 0)).toThrow("doctor-degraded");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, warnings: ["stale"] }), 0)).toThrow("doctor-warnings");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, status: "error" }), 1)).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, data: { ...healthy.data, problems: [{ page: "-", error: "drift" }] } }), 0)).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, data: { ...healthy.data, serve: { ok: false, failures: ["unit masked"] } } }), 0)).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope("{invalid", 0)).toThrow("doctor-invalid-json");
  });

  test("assertNoDegradedDiagnostics rejects spurious degraded stderr flags", () => {
    expect(() => assertNoDegradedDiagnostics("query", "")).not.toThrow();
    expect(() => assertNoDegradedDiagnostics("query", "0 hits\n")).not.toThrow();
    expect(() => assertNoDegradedDiagnostics("restored-query", "degraded=index-behind-ledger\n")).toThrow("restored-query-degraded");
    expect(() => assertNoDegradedDiagnostics("import", "degraded: derived-index\n")).toThrow("import-degraded");
  });

  for (const { verb, stepId, expectedFailure } of [
    { verb: "doctor", stepId: "cli-engine", expectedFailure: "doctor-degraded" },
    { verb: "import", stepId: "import", expectedFailure: "import-degraded" },
  ] as const) {
    test(`runArtifactProof fails and marks ${stepId} passed=false when ${verb} emits degraded stderr with exit 0`, async () => {
      const artifact = temporary("kizuki-proof-diag-");
      const report = join(temporary("kizuki-proof-report-"), "report");
      writePackageFixture(artifact, undefined, nativeReleaseTarget().target);
      const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
      const inject = `if [ "$1" = ${shellQuote(verb)} ]; then printf 'degraded=injected-fault\\n' >&2; fi\n`;
      writeFileSync(
        join(artifact, "kizuki"),
        `#!/bin/sh\n${inject}exec ${shellQuote(process.execPath)} ${shellQuote(resolve(repoRoot, "packages/cli/src/main.ts"))} "$@"\n`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(artifact, "kizuki-mcp"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve(repoRoot, "packages/mcp/src/bin.ts"))} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(artifact, "kizuki"), 0o700);
      chmodSync(join(artifact, "kizuki-mcp"), 0o700);
      writeFileSync(join(artifact, "SHA256SUMS"), checksumManifest(artifact, CURRENT_PACKAGE_FILES.slice(0, -1)));

      await expect(runArtifactProof({ artifact, report })).rejects.toThrow("artifact proof failed");
      const receipt = JSON.parse(readFileSync(join(report, "receipt.json"), "utf8")) as {
        steps: StepReceipt[];
        failures: string[];
      };
      const failedStep = receipt.steps.find((step) => step.id === stepId);
      expect(failedStep).toBeDefined();
      expect(failedStep?.exit_code).toBe(0);
      expect(failedStep?.passed).toBe(false);
      expect(receipt.failures).toEqual([expectedFailure]);
    });
  }
});
