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
      `Kizuki ${version} (${target})`,
      "",
      "This local package contains Kizuki, its dependencies and the Bun runtime",
      `for ${selected.description}. It is an unsigned, unpublished candidate;`,
      "check BUILD.json against the accompanying exact-source native proof receipt.",
      "",
      "Verify the package files before running either executable:",
      `  ${selected.checksum_command}`,
      "",
      "Keep both executables together in their final folder before setup.",
      "Open guided setup in your browser:",
      "  ./kizuki app",
      "",
      "Choose your workspace, then open Sources and start with a local Markdown",
      "folder. Review its permissions before capturing anything. Setup enables",
      "background activity by default when a supported user service manager is",
      "available. Setup options lets you opt out; Settings shows the current state.",
      "",
      "A model is optional: capture and search work with it turned off. To organise",
      "memory pages, choose a model in Settings, test the connection, then allow",
      "that model to use each intended source in Sources. Saving a model does not",
      "grant it access to your information.",
      "",
      'To connect an assistant, open Settings and choose "Set up an agent". Review',
      "its limited permissions, create it, and copy the generated MCP launch",
      "configuration into your assistant on this device. Keep its private credential",
      "file in place; the generated configuration refers to it without exposing it.",
      "",
      "If background setup fails, your workspace is retained. Open Settings to",
      "check the failure and retry. If you move the package, reinstall its service",
      "from the new folder with your workspace's absolute path:",
      "  ./kizuki serve --install --vault /absolute/workspace",
      "",
      "The executables do not automatically read .env or bunfig.toml. External network",
      "access is limited to configured connectors and model endpoints. The PostgreSQL/pgvector",
      "retrieval engine and tokenizer are bundled for offline use. Local GGUF model",
      "weights are not bundled; search remains available without them.",
      "",
      "On macOS this candidate is not signed or notarized. If macOS blocks launch,",
      "retain the message and report it; do not bypass the operating system check.",
      "",
      "Setup and service recovery:",
      `  https://github.com/Illuminfti/kizuki/blob/${sourceSha}/docs/local-app.md`,
      "Backup, restore and diagnostics:",
      `  https://github.com/Illuminfti/kizuki/blob/${sourceSha}/docs/cli.md`,
      "Legacy extraction recovery:",
      `  https://github.com/Illuminfti/kizuki/blob/${sourceSha}/docs/extraction-recovery.md`,
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
