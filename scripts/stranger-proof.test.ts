import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildInfo, parseProofArgs, proofEnvironment, requireFixture, runArtifactProof } from "./stranger-proof";
import { writePackageFixture } from "./release-package-fixture";
import { checksumManifest, CURRENT_PACKAGE_FILES, packageFileLimit } from "./release-artifacts";
import { nativeReleaseTarget, releaseTarget } from "./release-targets";
import { PACKAGED_CLI_COMMANDS, packagedCommandLine, packagedQuickStart } from "./build-release";
import { COMMANDS } from "../packages/cli/src/commands/index";
import { extractVault, parseArguments } from "../packages/cli/src/args";
import { RETIRED_OWNER_GATE_VERBS } from "../packages/cli/src/retired";
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

describe("packaged recovery instructions", () => {
  const packagedArgv = Object.values(PACKAGED_CLI_COMMANDS);
  const liveCommands = new Map(COMMANDS.map(command => [command.name, command]));

  test("match current CLI parsing and refuse serve --start", () => {
    for (const argv of packagedArgv) {
      const [bin, verb] = argv;
      expect(bin).toBe("./kizuki");
      if (verb === undefined) throw new Error("packaged command missing verb");
      expect((RETIRED_OWNER_GATE_VERBS as readonly string[]).includes(verb)).toBe(false);
      expect(["capture", "search", "start"]).not.toContain(verb);
      const command = liveCommands.get(verb);
      if (command === undefined) throw new Error(`packaged verb is not a live CLI command: ${verb}`);
      const { rest } = extractVault([...argv.slice(1)]);
      expect(rest[0]).toBe(verb);
      const parsed = parseArguments(rest.slice(1), {
        options: [...(command.schema?.options ?? [])],
        flags: [...(command.schema?.flags ?? [])],
      });
      if (command.name === "serve") {
        for (const positional of parsed.positionals) expect(command.usage).toContain(positional);
      }
    }
    const serve = liveCommands.get("serve");
    if (serve === undefined) throw new Error("serve command missing");
    expect(() => parseArguments(["--start"], {
      options: [...(serve.schema?.options ?? [])],
      flags: [...(serve.schema?.flags ?? [])],
    })).toThrow("unknown option --start");
  });

  test("quick-start prints those commands and no fake recovery verbs", () => {
    const sourceSha = "b".repeat(40);
    const linux = packagedQuickStart({ version: "0.1.0", target: releaseTarget("bun-linux-x64-baseline"), sourceSha });
    const darwin = packagedQuickStart({ version: "0.1.0", target: releaseTarget("bun-darwin-arm64"), sourceSha });
    expect(linux.length).toBeLessThanOrEqual(packageFileLimit("README.txt"));
    expect(darwin.length).toBeLessThanOrEqual(packageFileLimit("README.txt"));
    expect(linux).toContain("sha256sum -c SHA256SUMS");
    expect(darwin).toContain("shasum -a 256 -c SHA256SUMS");
    expect(linux).toContain("unsigned, unpublished candidate");
    expect(linux).toContain("not signed or notarized");
    expect(linux).toContain("canon writing: off");
    expect(linux).toContain("Uninstall does not delete the workspace.");
    expect(linux).toContain(`blob/${sourceSha}/docs/local-app.md`);
    const printed = linux.split("\n").filter(line => line.startsWith("  ./kizuki"));
    expect(printed).toEqual(packagedArgv.map(argv => packagedCommandLine(argv)));
    expect(printed.join("\n")).not.toContain("capture");
    expect(printed.join("\n")).not.toContain("search");
    expect(printed.join("\n")).not.toContain("start");
  });

  test("local app recovery guide names the same live CLI forms", () => {
    const guide = readFileSync(join(import.meta.dir, "../docs/local-app.md"), "utf8");
    for (const argv of packagedArgv) expect(guide).toContain(argv.join(" "));
    expect(guide).toContain("canon writing: off");
    expect(guide).toContain("do not delete the vault");
    const printed = guide.split("\n").filter(line => line.startsWith("./kizuki"));
    expect(printed.join("\n")).not.toContain("capture");
    expect(printed.join("\n")).not.toContain("search");
    expect(printed.join("\n")).not.toContain("start");
  });
});
