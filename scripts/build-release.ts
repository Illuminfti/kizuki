import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checksumManifest, ensureReleaseDirectory, requireAbsent, CURRENT_PACKAGE_FILES, parseBuildInfo, verifyPackageDirectory } from "./release-artifacts";

import { createPackageDistribution, BUN_DISTRIBUTION_PIN } from "./release-notices";

import { selectedReleaseTarget } from "./release-targets";

const root = resolve(import.meta.dir, "..");
const pinnedBun = (await Bun.file(resolve(root, ".bun-version")).text()).trim();
if (Bun.version !== pinnedBun || Bun.revision !== BUN_DISTRIBUTION_PIN.revision) {
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

const metafiles: Partial<Record<"kizuki" | "kizuki-mcp", NonNullable<Awaited<ReturnType<typeof Bun.build>>["metafile"]>>> = {};
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
      metafile: true,
    });
    if (!result.success || !result.metafile) {
      throw new Error(`could not compile ${binary.name}: ${result.logs.join("\n")}`);
    }
    metafiles[binary.name] = result.metafile;
  }

  requireBuildState();
  const materials = createPackageDistribution(root, sourceSha, { kizuki: metafiles.kizuki!, "kizuki-mcp": metafiles["kizuki-mcp"]! });
  writeFileSync(resolve(staging, "LICENSE"), materials.license);
  writeFileSync(resolve(staging, "THIRD-PARTY-NOTICES.txt"), materials.notices);
  writeFileSync(
    resolve(staging, "README.txt"),
    [
      `Kizuki ${version} (${target})`,
      "",
      "This local package contains Kizuki, its dependencies and the Bun runtime",
      `for ${selected.description}. It is an unsigned, unpublished candidate;`,
      "check BUILD.json against the accompanying exact-source native proof receipt.",
      "LICENSE covers Kizuki; THIRD-PARTY-NOTICES.txt records bundled material",
      "and unresolved notice/source information. Distribution has not been assessed.",
      "",
      "Verify the package files before running either executable:",
      `  ${selected.checksum_command}`,
      "",
      "Keep both executables together in their final folder before setup.",
      "Use a graphical desktop with a default web browser. Linux requires",
      "/usr/bin/xdg-open (usually supplied by xdg-utils); macOS uses /usr/bin/open.",
      "Bun, Node and an external compiler are not required to run this package.",
      "In a terminal, change to this folder before running the command below.",
      "Open guided setup in your browser:",
      "  ./kizuki app",
      "",
      "Choose your workspace, then open Sources and start with a local Markdown",
      "folder. Review its permissions before capturing anything. Setup enables",
      "background activity by default when a supported user service manager is",
      "available. Setup options lets you opt out; Settings shows the current state.",
      "Enter the full path to an existing notes folder outside the new workspace.",
      "If the browser cannot open, check the desktop session and default browser",
      "and retry. --no-open is diagnostic; its printed address does not sign you in.",
      "",
      "A model is optional: capture and search work with it turned off. To organise",
      "memory pages, choose a model in Settings, test the connection, then allow",
      "that model to use each intended source in Sources. Saving a model does not",
      "grant it access to your information.",
      "You need a reachable compatible API endpoint, its exact model ID and any",
      "required provider API credential, or a compatible local server you have",
      "already configured. This package does not supply a hosted account or model.",
      "",
      'To connect an assistant, open Settings and choose "Set up an agent". Review',
      "its limited permissions, create it, and copy the generated MCP launch",
      "configuration into your assistant on this device. Keep its private credential",
      "file in place; the generated configuration refers to it without exposing it.",
      "Your assistant must support local MCP processes. The setup guide below",
      "includes the Codex CLI command; the generated object is not a complete",
      "configuration file for every assistant.",
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
      schema: "kizuki.release-build/v2",
      source_sha: sourceSha,
      target,
      bun_version: Bun.version,
      distribution: materials.distribution,
    }, null, 2)}\n`,
    "utf8",
  );
  const packaged = CURRENT_PACKAGE_FILES.slice(0, -1);
  writeFileSync(resolve(staging, "SHA256SUMS"), checksumManifest(staging, packaged), "utf8");
  verifyPackageDirectory(staging, parseBuildInfo(resolve(staging, "BUILD.json")));
  // The target was checked absent before staging. This rename publishes a complete package.
  requireBuildState();
  requireAbsent(output);
  renameSync(staging, output);
  published = true;
} finally {
  if (!published) rmSync(staging, { force: true, recursive: true });
}

process.stdout.write(`${output}\n`);
