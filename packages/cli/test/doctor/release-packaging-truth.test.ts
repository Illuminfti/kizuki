import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RAIL_IDS } from "@kizuki/core";
import {
  MAX_BUILD_TIMESTAMP_EPOCH_SECONDS,
  PACKAGED_POLICY_CREATE_COMMAND,
  assertNoEmbeddedRootPath,
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

setDefaultTimeout(180_000);

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

function createIndependentCheckout(destination: string): void {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tracked.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${tracked.stderr.toString()}`);
  }
  const files = tracked.stdout.toString().split("\0").filter(Boolean);
  mkdirSync(destination, { recursive: true });
  for (const rel of files) {
    const source = join(repoRoot, rel);
    if (!existsSync(source)) continue;
    const target = join(destination, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { force: true });
  }
  const gitEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: destination,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Kizuki Repro",
    GIT_AUTHOR_EMAIL: "repro@example.com",
    GIT_COMMITTER_NAME: "Kizuki Repro",
    GIT_COMMITTER_EMAIL: "repro@example.com",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const runGit = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: destination,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
  };
  runGit(["init", "-q"]);
  runGit(["add", "-A"]);
  runGit(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "reproducible release fixture"]);
  cpSync(join(repoRoot, "node_modules"), join(destination, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    const pkgModules = join(repoRoot, "packages", pkg, "node_modules");
    if (!existsSync(pkgModules)) continue;
    cpSync(pkgModules, join(destination, "packages", pkg, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

function makeRails(state: "idle" | "ok") {
  return RAIL_IDS.map((rail) => ({
    rail,
    status: state,
    last_result: state === "idle" ? null : "ok",
    reason: null,
    degraded_streak: 0,
  }));
}

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

  test("two independent checkout paths build byte-identical full release manifests with no embedded checkout paths", async () => {
    const workspace = temporary("kizuki-reproducible-release-");
    const checkoutA = join(workspace, "src-a");
    const checkoutB = join(workspace, "independent-checkout-beta");
    createIndependentCheckout(checkoutA);
    createIndependentCheckout(checkoutB);

    const buildIn = (checkout: string): string => {
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "scripts/build-release.ts"], {
        cwd: checkout,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: join(workspace, "home"),
          ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`release build in ${checkout} failed: ${result.stderr.toString()}`);
      }
      return result.stdout.toString().trim();
    };

    const releaseA = buildIn(checkoutA);
    await Bun.sleep(1050);
    const releaseB = buildIn(checkoutB);

    const manifestA = readFileSync(join(releaseA, "SHA256SUMS"), "utf8");
    const manifestB = readFileSync(join(releaseB, "SHA256SUMS"), "utf8");
    expect(manifestB).toBe(manifestA);

    for (const binary of ["kizuki", "kizuki-mcp"] as const) {
      const pathA = join(releaseA, binary);
      const pathB = join(releaseB, binary);
      assertNoEmbeddedRootPath(pathA, checkoutA);
      assertNoEmbeddedRootPath(pathB, checkoutB);
      expect(readFileSync(pathA).includes(Buffer.from(repoRoot))).toBe(false);
    }

    const leaked = join(workspace, "leaked-bin");
    writeFileSync(leaked, `prefix ${checkoutA}/node_modules/bufferutil suffix`, "utf8");
    expect(() => assertNoEmbeddedRootPath(leaked, checkoutA)).toThrow("embeds build checkout path");
  });

  test("packagedQuickStart includes runnable ./kizuki version, policy setup, PATH symlinks, 14-tool MCP note, and clean prose", () => {
    const sha = "c".repeat(40);
    const text = packagedQuickStart({ version: "1.0.2", target: selectedReleaseTarget(), sourceSha: sha });
    expect(text).toContain("./kizuki version");
    expect(text).not.toContain("with: kizuki version");
    expect(text).toContain(`  ${PACKAGED_POLICY_CREATE_COMMAND}`);
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
  test("assertCleanDoctorEnvelope enforces healthy doctor JSON, expected rails, and clean stderr", () => {
    const healthy = {
      schema: "kizuki.cli.doctor/v1",
      status: "ok",
      degraded: [] as string[],
      warnings: [] as string[],
      data: {
        ok: true,
        problems: [] as unknown[],
        ledger: { ok: true },
        serve: { ok: true, failures: [] as unknown[], rails: makeRails("idle") },
      },
    };
    const healthyOk = {
      ...healthy,
      data: { ...healthy.data, serve: { ...healthy.data.serve, rails: makeRails("ok") } },
    };
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0)).not.toThrow();
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "")).not.toThrow();
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthyOk), 0, "", "ok")).not.toThrow();
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "", "ok")).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthyOk), 0, "", "idle")).toThrow("doctor-unhealthy");

    const degradedRail = makeRails("idle").map((rail) =>
      rail.rail === "sync" ? { ...rail, last_result: "degraded", degraded_streak: 1 } : rail,
    );
    expect(() =>
      assertCleanDoctorEnvelope(
        JSON.stringify({ ...healthy, data: { ...healthy.data, serve: { ...healthy.data.serve, rails: degradedRail } } }),
        0,
      ),
    ).toThrow("doctor-degraded");
    const degradedStatusRail = makeRails("ok").map((rail) =>
      rail.rail === "sync" ? { ...rail, status: "degraded", last_result: "degraded", degraded_streak: 1 } : rail,
    );
    expect(() =>
      assertCleanDoctorEnvelope(
        JSON.stringify({ ...healthy, data: { ...healthy.data, serve: { ...healthy.data.serve, rails: degradedStatusRail } } }),
        0,
        "",
        "ok",
      ),
    ).toThrow("doctor-degraded");
    expect(() =>
      assertCleanDoctorEnvelope(
        JSON.stringify({ ...healthy, data: { ...healthy.data, serve: { ...healthy.data.serve, rails: makeRails("idle").slice(1) } } }),
        0,
      ),
    ).toThrow("doctor-unhealthy");

    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "degraded=index-behind-ledger\n")).toThrow("doctor-degraded");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify(healthy), 0, "unexpected warning\n")).toThrow("doctor-stderr");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, degraded: ["index-behind-ledger"] }), 0)).toThrow("doctor-degraded");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, warnings: ["stale"] }), 0)).toThrow("doctor-warnings");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, status: "error" }), 1)).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, data: { ...healthy.data, problems: [{ page: "-", error: "drift" }] } }), 0)).toThrow("doctor-unhealthy");
    expect(() => assertCleanDoctorEnvelope(JSON.stringify({ ...healthy, data: { ...healthy.data, serve: { ok: false, failures: ["unit masked"], rails: makeRails("idle") } } }), 0)).toThrow("doctor-unhealthy");
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
