import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checksumManifest, ensureReleaseDirectory, requireAbsent } from "./release-artifacts";

const root = resolve(import.meta.dir, "..");
const pinnedBun = (await Bun.file(resolve(root, ".bun-version")).text()).trim();
if (Bun.version !== pinnedBun) {
  throw new Error(`native builds require Bun ${pinnedBun}; current runtime is ${Bun.version}`);
}
const version = (await Bun.file(resolve(root, "packages/cli/package.json")).json() as {
  version: string;
}).version;
const target = process.env.KIZUKI_TARGET ?? "bun-linux-x64-baseline";

if (target !== "bun-linux-x64-baseline") {
  throw new Error(`unsupported release target: ${target}`);
}

const dist = resolve(root, "dist");
const release = join(dist, `kizuki-${version}`);
const output = join(release, target);
ensureReleaseDirectory(dist);
ensureReleaseDirectory(release);
requireAbsent(output);
const staging = mkdtempSync(join(dist, ".kizuki-release-"));

const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: root,
  stderr: "pipe",
  stdout: "pipe",
});
const sourceSha = new TextDecoder().decode(revision.stdout).trim();
if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("native builds require a Git revision");
}
const status = Bun.spawnSync(["git", "status", "--porcelain"], {
  cwd: root,
  stderr: "pipe",
  stdout: "pipe",
});
if (status.exitCode !== 0 || new TextDecoder().decode(status.stdout).trim() !== "") {
  throw new Error("native builds require a clean tracked Git tree");
}

const binaries = [
  { entrypoint: "packages/cli/src/main.ts", name: "kizuki" },
  { entrypoint: "packages/mcp/src/bin.ts", name: "kizuki-mcp" },
] as const;

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

writeFileSync(
  resolve(staging, "README.txt"),
  [
    `Kizuki ${version} — ${target}`,
    "",
    "This local package contains Bun executables with the Kizuki code, dependencies,",
    "and Bun runtime bundled for Linux x86_64",
    "baseline CPUs. It has not been published, signed, or tested on other operating systems.",
    "",
    "Verify the binaries before running them:",
    "  sha256sum -c SHA256SUMS",
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
    "access remains explicit configuration. Local GGUF models and optional retrieval",
    "engines are not bundled; the deterministic lexical floor remains available.",
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
requireAbsent(output);
renameSync(staging, output);

process.stdout.write(`${output}\n`);
