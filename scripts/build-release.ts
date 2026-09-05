import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checksumManifest, ensureReleaseDirectory, requireAbsent } from "./release-artifacts";

import { selectedReleaseTarget } from "./release-targets";

const root = resolve(import.meta.dir, "..");
const pinnedBun = (await Bun.file(resolve(root, ".bun-version")).text()).trim();
if (Bun.version !== pinnedBun) {
  throw new Error(`native builds require Bun ${pinnedBun}; current runtime is ${Bun.version}`);
}
const version = (await Bun.file(resolve(root, "packages/cli/package.json")).json() as {
  version: string;
}).version;
const selected = selectedReleaseTarget();
const target = selected.target;

const dist = resolve(root, "dist");
const release = join(dist, `kizuki-${version}`);
const output = join(release, target);
ensureReleaseDirectory(dist);
ensureReleaseDirectory(release);
requireAbsent(output);

function gitText(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error("native builds require a Git revision");
  return new TextDecoder().decode(result.stdout).trim();
}

const sourceSha = gitText(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("native builds require a Git revision");
}

function requireBuildState(): void {
  if (gitText(["rev-parse", "HEAD"]) !== sourceSha || gitText(["status", "--porcelain"]) !== "") {
    throw new Error("native builds require the source revision to remain clean and unchanged");
  }
}
requireBuildState();
const staging = mkdtempSync(join(dist, ".kizuki-release-"));

const binaries = [
  { entrypoint: "packages/cli/src/main.ts", name: "kizuki" },
  { entrypoint: "packages/mcp/src/bin.ts", name: "kizuki-mcp" },
] as const;

let published = false;
try {
  for (const binary of binaries) {
    const result = await Bun.build({
      entrypoints: [resolve(root, binary.entrypoint)],
      compile: {
        target,
        outfile: resolve(staging, binary.name),
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
      define: { KIZUKI_COMPILED: "true" },
    });
    if (!result.success) {
      throw new Error(`could not compile ${binary.name}: ${result.logs.join("\n")}`);
    }
  }

  requireBuildState();
  writeFileSync(
    resolve(staging, "README.txt"),
    [
      `Kizuki ${version} — ${target}`,
      "",
      "This local package contains Bun executables with the Kizuki code, dependencies,",
      `and Bun runtime bundled for ${selected.description}.`,
      "This package is unsigned and unpublished; consult its exact-head native proof receipt.",
      "",
      "Verify the binaries before running them:",
      `  ${selected.checksum_command}`,
      "",
      "Run the CLI:",
      "  ./kizuki --help",
      "  ./kizuki init ./my-vault --no-service",
      "",
      "Run the MCP stdio adapter:",
      "  ./kizuki-mcp --vault ./my-vault --owner",
      "",
      "The executables do not read .env or bunfig.toml automatically and do not",
      "perform runtime network access on their own. Connector and model network",
      "access remains explicit configuration. The optional embedded PostgreSQL/pgvector",
      "retrieval engine and context tokenizer are bundled for offline use. Local GGUF",
      "model weights are not bundled; the deterministic lexical floor remains available.",
      "",
      "Service installation uses the executable's own path. Do not move a binary after",
      "installing its service; rerun `kizuki serve --install` from its final location.",
    ].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    resolve(staging, "BUILD.json"),
    `${JSON.stringify({
      schema: "kizuki.release-build/v1",
      source_sha: sourceSha,
      target,
      bun_version: Bun.version,
    }, null, 2)}\n`,
    "utf8",
  );
  const packaged = [...binaries.map(({ name }) => name), "README.txt", "BUILD.json"];
  writeFileSync(resolve(staging, "SHA256SUMS"), checksumManifest(staging, packaged), "utf8");
  // The target was checked absent before staging. This rename publishes a complete package.
  requireBuildState();
  requireAbsent(output);
  renameSync(staging, output);
  published = true;
} finally {
  if (!published) rmSync(staging, { force: true, recursive: true });
}

process.stdout.write(`${output}\n`);
