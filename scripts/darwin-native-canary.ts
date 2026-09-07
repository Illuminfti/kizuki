import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Receipt = {
  schema: "kizuki.darwin-native-canary/v1";
  source_sha: string;
  target: "bun-darwin-arm64";
  bun_version: string;
  host_platform: string;
  host_arch: string;
  environment: { home_isolated: boolean; path_unavailable: boolean; developer_dir_invalid: boolean; sdkroot_unavailable: boolean };
  executable_sha256: { built: string; copied: string; executed: string } | null;
  exit_code: number | null;
  passed: boolean;
  failure: string | null;
  diagnostics: { stdout: string; stderr: string } | null;
};

const root = resolve(import.meta.dir, "..");
const fixture = resolve(import.meta.dir, "fixtures", "darwin-native-canary.ts");

function parseArgs(args: readonly string[]): { report: string } {
  if (args.length !== 2 || args[0] !== "--report" || !args[1]) {
    throw new Error("usage: bun scripts/darwin-native-canary.ts --report DIR");
  }
  return { report: resolve(args[1]) };
}

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const value = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(value)) throw new Error("Darwin canary requires an exact Git revision");
  return value;
}

function requireCleanHead(sourceSha: string): void {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 || result.stdout.toString() !== "" || gitHead() !== sourceSha) {
    throw new Error("Darwin canary requires an unchanged exact Git revision");
  }
}

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function diagnostics(value: Uint8Array): string {
  const text = Buffer.from(value).toString("utf8");
  return text.length <= 4096 ? text : `${text.slice(0, 4096)}[truncated]`;
}

function writeReceipt(report: string, receipt: Receipt): void {
  mkdirSync(report, { recursive: true, mode: 0o700 });
  chmodSync(report, 0o700);
  writeFileSync(join(report, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function runDarwinNativeCanary(args: readonly string[]): Promise<string> {
  const { report } = parseArgs(args);
  const sourceSha = gitHead();
  mkdirSync(report, { recursive: true, mode: 0o700 });
  chmodSync(report, 0o700);
  const receipt: Receipt = {
    schema: "kizuki.darwin-native-canary/v1", source_sha: sourceSha, target: "bun-darwin-arm64", bun_version: Bun.version,
    host_platform: process.platform, host_arch: process.arch,
    environment: { home_isolated: true, path_unavailable: true, developer_dir_invalid: true, sdkroot_unavailable: true },
    executable_sha256: null, exit_code: null, passed: false, failure: null, diagnostics: null,
  };
  const sandbox = mkdtempSync(join(tmpdir(), "kizuki-darwin-native-canary-"));
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Darwin canary requires macOS arm64");
    if (Bun.version !== "1.3.14") throw new Error(`Darwin canary requires Bun 1.3.14; current runtime is ${Bun.version}`);
    requireCleanHead(sourceSha);
    const executable = join(sandbox, "darwin-native-canary");
    const build = await Bun.build({
      entrypoints: [fixture],
      compile: { target: "bun-darwin-arm64", outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    });
    if (!build.success || !existsSync(executable)) throw new Error("could not compile Darwin native canary");
    requireCleanHead(sourceSha);
    const builtHash = sha256(executable);
    copyFileSync(executable, join(report, "darwin-native-canary"));
    chmodSync(join(report, "darwin-native-canary"), 0o700);
    const isolated = join(sandbox, "isolated");
    mkdirSync(isolated, { recursive: true, mode: 0o700 });
    const owned = join(isolated, "owned");
    mkdirSync(owned, { recursive: true, mode: 0o700 });
    const copied = join(isolated, "darwin-native-canary");
    copyFileSync(join(report, "darwin-native-canary"), copied);
    chmodSync(copied, 0o700);
    const copiedHash = sha256(join(report, "darwin-native-canary"));
    const executedHash = sha256(copied);
    if (builtHash !== copiedHash || copiedHash !== executedHash) throw new Error("compiled Darwin canary changed before execution");
    receipt.executable_sha256 = { built: builtHash, copied: copiedHash, executed: executedHash };
    const result = Bun.spawnSync([copied], {
      cwd: isolated,
      env: {
        HOME: join(isolated, "home"), PATH: join(isolated, "no-path"), DEVELOPER_DIR: join(isolated, "invalid-developer-dir"),
        SDKROOT: join(isolated, "unavailable-sdk"), KIZUKI_DARWIN_CANARY_ROOT: realpathSync(owned),
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    receipt.exit_code = result.exitCode;
    receipt.diagnostics = { stdout: diagnostics(result.stdout), stderr: diagnostics(result.stderr) };
    if (result.exitCode !== 0 || result.stdout.toString() !== "darwin-native-canary: passed\n" || result.stderr.toString() !== "") {
      throw new Error("compiled Darwin native canary failed");
    }
    if (sha256(executable) !== builtHash || sha256(join(report, "darwin-native-canary")) !== copiedHash || sha256(copied) !== executedHash) {
      throw new Error("compiled Darwin canary changed during execution");
    }
    requireCleanHead(sourceSha);
    receipt.passed = true;
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : "Darwin native canary failed";
  } finally {
    writeReceipt(report, receipt);
    rmSync(sandbox, { force: true, recursive: true });
  }
  if (!receipt.passed) throw new Error(`Darwin native canary failed; receipt=${join(report, "receipt.json")}`);
  return join(report, "receipt.json");
}

if (import.meta.main) {
  const receipt = await runDarwinNativeCanary(Bun.argv.slice(2));
  process.stdout.write(`Darwin native canary passed: ${receipt}\n`);
}
