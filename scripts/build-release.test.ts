import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_CREDENTIALS_MESSAGE } from "../packages/connector-telegram/src/app-credentials";
import { COMPILED_CREDENTIAL_GROUPS, packagedQuickStart, resolveCompiledCredentials, type CredentialGroup } from "./build-release";
import { checksumManifest, parseBuildInfoValue } from "./release-artifacts";
import { distributionFixture } from "./release-package-fixture";
import { BUN_DISTRIBUTION_PIN } from "./release-notices";
import { selectedReleaseTarget } from "./release-targets";

/** Synthetic, low-entropy, and never written to a tracked file as one literal. */
const SYNTHETIC = { KIZUKI_TELEGRAM_API_ID: "1200003", KIZUKI_TELEGRAM_API_HASH: "ab".repeat(16) } as const;
const TELEGRAM_NAMES = ["KIZUKI_TELEGRAM_API_HASH", "KIZUKI_TELEGRAM_API_ID"];
const CREDENTIAL_MODULE = join(import.meta.dir, "../packages/connector-telegram/src/app-credentials.ts");

/** Reports what the compiled binary itself resolves, then takes the refusal path. */
const PROBE_SOURCE = `import { appCredentials, requireAppCredentials } from ${JSON.stringify(CREDENTIAL_MODULE)};
let refusal: { code: string; message: string } | null = null;
try {
  requireAppCredentials(appCredentials);
} catch (error) {
  refusal = { code: (error as { code: string }).code, message: (error as Error).message };
}
process.stdout.write(JSON.stringify({ configured: appCredentials() !== null, refusal }) + "\\n");
process.exit(refusal === null ? 0 : 3);
`;

interface ProbeRun { exit: number; stdout: string; stderr: string; report: { configured: boolean; refusal: { code: string; message: string } | null } }

/** Compiles the probe exactly as `build:release` compiles a binary, then runs it with a scrubbed environment. */
async function compileProbe(directory: string, name: string, environment: Record<string, string>): Promise<ProbeRun & { binary: string }> {
  const entrypoint = join(directory, `${name}.ts`);
  const binary = join(directory, name);
  writeFileSync(entrypoint, PROBE_SOURCE, "utf8");
  const built = await Bun.build({
    entrypoints: [entrypoint],
    compile: { target: selectedReleaseTarget().target, outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
    define: { KIZUKI_COMPILED: "true", ...resolveCompiledCredentials(environment).define },
  });
  if (!built.success) throw new Error(`probe build failed: ${built.logs.join("\n")}`);
  return { binary, ...runProbe(binary, {}) };
}

/** Runs a compiled probe with nothing inherited but `PATH`, so the run environment is exactly what is passed. */
function runProbe(binary: string, environment: Record<string, string>): ProbeRun {
  const run = Bun.spawnSync([binary], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...environment }, stdout: "pipe", stderr: "pipe" });
  const stdout = run.stdout.toString();
  return { exit: run.exitCode, stdout, stderr: run.stderr.toString(), report: JSON.parse(stdout) };
}

/** The text files a package ships, built by the same producers the release build uses. */
function packageTexts(directory: string, names: readonly string[]): Record<string, string> {
  const material = distributionFixture();
  const build = {
    schema: "kizuki.release-build/v2" as const, source_sha: "a".repeat(40), target: selectedReleaseTarget().target,
    bun_version: BUN_DISTRIBUTION_PIN.version, compiled_credentials: names, distribution: material.distribution,
  };
  parseBuildInfoValue(build);
  writeFileSync(join(directory, "BUILD.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "README.txt"), packagedQuickStart({ version: "0.1.0", target: selectedReleaseTarget(), sourceSha: "a".repeat(40) }), "utf8");
  writeFileSync(join(directory, "SHA256SUMS"), checksumManifest(directory, ["BUILD.json", "README.txt"]), "utf8");
  return Object.fromEntries(["BUILD.json", "README.txt", "SHA256SUMS"].map(name => [name, readFileSync(join(directory, name), "utf8")]));
}

test("a supplied credential pair is compiled in, recorded by name, and kept out of every package text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-compiled-credentials-"));
  try {
    const resolved = resolveCompiledCredentials({ ...SYNTHETIC, KIZUKI_SOMETHING_ELSE: "unrelated" });
    expect(resolved.names).toEqual(TELEGRAM_NAMES);
    expect(Object.keys(resolved.define).sort()).toEqual(TELEGRAM_NAMES.map(name => `process.env.${name}`));

    const probe = await compileProbe(directory, "kizuki-credentialed", { ...SYNTHETIC });
    expect(probe.exit).toBe(0);
    expect(probe.report).toEqual({ configured: true, refusal: null });
    // The values reached the binary, which is the only place they may exist.
    for (const value of Object.values(SYNTHETIC)) expect(readFileSync(probe.binary).includes(value)).toBe(true);

    const texts: Record<string, string> = { ...packageTexts(directory, resolved.names), "probe output": probe.stdout + probe.stderr };
    for (const [name, text] of Object.entries(texts)) {
      for (const value of Object.values(SYNTHETIC)) expect([name, text.includes(value)]).toEqual([name, false]);
    }
    for (const name of TELEGRAM_NAMES) expect(texts["BUILD.json"]).toContain(name);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 180_000);

test("an unset pair still builds, records no credential, and refuses sign-in with the documented message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-compiled-credentials-"));
  try {
    const resolved = resolveCompiledCredentials({ PATH: "/usr/bin" });
    expect(resolved).toEqual({ names: [], define: {} });

    const probe = await compileProbe(directory, "kizuki-uncredentialed", {});
    expect(probe.exit).toBe(3);
    expect(probe.report.configured).toBe(false);
    expect(probe.report.refusal).toEqual({ code: "placeholder_credentials", message: PLACEHOLDER_CREDENTIALS_MESSAGE });
    for (const name of TELEGRAM_NAMES) expect(PLACEHOLDER_CREDENTIALS_MESSAGE).toContain(name);
    for (const value of Object.values(SYNTHETIC)) expect(readFileSync(probe.binary).includes(value)).toBe(false);

    expect(packageTexts(directory, resolved.names)["BUILD.json"]).toContain('"compiled_credentials": []');

    // The two reads fall back to the live environment, so an operator holding a
    // registered pair can supply it to a credential-free package without rebuilding.
    const supplied = runProbe(probe.binary, { ...SYNTHETIC });
    expect(supplied.exit).toBe(0);
    expect(supplied.report).toEqual({ configured: true, refusal: null });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 180_000);

test("the allowlist is closed and every group is all or nothing", () => {
  expect(COMPILED_CREDENTIAL_GROUPS.map(group => group.source)).toEqual(["kizuki.telegram"]);
  const unrelated = resolveCompiledCredentials({ KIZUKI_SOMETHING_ELSE: "unrelated", KIZUKI_GMAIL_CLIENT_ID: "unrelated" });
  expect(unrelated).toEqual({ names: [], define: {} });
  for (const name of TELEGRAM_NAMES) {
    expect(() => resolveCompiledCredentials({ [name]: SYNTHETIC[name as keyof typeof SYNTHETIC] }))
      .toThrow("release credentials for kizuki.telegram are incomplete");
    expect(() => resolveCompiledCredentials({ ...SYNTHETIC, [name]: "" }))
      .toThrow("release credentials for kizuki.telegram are incomplete");
  }
});

test("a malformed value or allowlist entry fails the build instead of half-credentialing the binary", () => {
  for (const malformed of [{ KIZUKI_TELEGRAM_API_ID: "0" }, { KIZUKI_TELEGRAM_API_ID: "12 34" }, { KIZUKI_TELEGRAM_API_ID: "1e6" },
    { KIZUKI_TELEGRAM_API_HASH: "ab".repeat(8) }, { KIZUKI_TELEGRAM_API_HASH: "AB".repeat(16) }, { KIZUKI_TELEGRAM_API_HASH: `${"ab".repeat(15)}a\n` }]) {
    const [name] = Object.keys(malformed);
    expect(() => resolveCompiledCredentials({ ...SYNTHETIC, ...malformed })).toThrow(`release credential ${name} is malformed`);
  }
  const malformedGroups: readonly CredentialGroup[] = [{ source: "kizuki.telegram", values: { "KIZUKI_TELEGRAM_*": /^.+$/ } }];
  expect(() => resolveCompiledCredentials({}, malformedGroups)).toThrow("release credential allowlist is malformed");
  expect(() => resolveCompiledCredentials({}, [{ source: "kizuki.telegram", values: {} }])).toThrow("names no credential");
  expect(() => resolveCompiledCredentials({}, [COMPILED_CREDENTIAL_GROUPS[0], COMPILED_CREDENTIAL_GROUPS[0]])).toThrow("allowlist is malformed");
});

test("BUILD.json accepts only an ascending list of credential names", () => {
  const material = distributionFixture();
  const base = { schema: "kizuki.release-build/v2" as const, source_sha: "a".repeat(40), target: "bun-linux-x64-baseline",
    bun_version: BUN_DISTRIBUTION_PIN.version, distribution: material.distribution };
  // A package built before the field existed stays readable and claims nothing.
  expect(parseBuildInfoValue({ ...base }).schema).toBe("kizuki.release-build/v2");
  expect(parseBuildInfoValue({ ...base, compiled_credentials: [] })).toBeTruthy();
  expect(parseBuildInfoValue({ ...base, compiled_credentials: TELEGRAM_NAMES })).toBeTruthy();
  for (const invalid of [TELEGRAM_NAMES.slice().reverse(), [TELEGRAM_NAMES[0], TELEGRAM_NAMES[0]], ["kizuki_telegram_api_id"],
    ["TELEGRAM_API_ID"], ["KIZUKI_TELEGRAM_API_ID=1200003"], [SYNTHETIC.KIZUKI_TELEGRAM_API_HASH], "KIZUKI_TELEGRAM_API_ID",
    [1], [`KIZUKI_${"A".repeat(200)}`], Array.from({ length: 17 }, (_, index) => `KIZUKI_N${index}`)]) {
    expect(() => parseBuildInfoValue({ ...base, compiled_credentials: invalid })).toThrow("invalid shape");
  }
});
