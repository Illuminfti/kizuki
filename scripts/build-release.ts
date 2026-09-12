import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checksumManifest, ensureReleaseDirectory, requireAbsent, CURRENT_PACKAGE_FILES, parseBuildInfo, verifyPackageDirectory } from "./release-artifacts";

import { createPackageDistribution, BUN_DISTRIBUTION_PIN } from "./release-notices";

import { selectedReleaseTarget, type ReleaseTarget } from "./release-targets";

/** Exact CLI forms printed in the packaged quick-start. Placeholder paths are absolute. */
export const PACKAGED_CLI_COMMANDS = {
  app: ["./kizuki", "app"],
  init: ["./kizuki", "init", "/absolute/workspace", "--no-service"],
  import: ["./kizuki", "import", "markdown-folder", "--source", "/absolute/notes", "--policy", "/absolute/policy.json", "--expected-revision", "0", "--operation-id", "first-import", "--vault", "/absolute/workspace"],
  query: ["./kizuki", "query", "acme", "--vault", "/absolute/workspace"],
  doctor: ["./kizuki", "doctor", "--vault", "/absolute/workspace"],
  serveInstall: ["./kizuki", "serve", "--install", "--vault", "/absolute/workspace"],
  serveStop: ["./kizuki", "serve", "stop", "--vault", "/absolute/workspace"],
  serveUninstall: ["./kizuki", "serve", "--uninstall", "--vault", "/absolute/workspace"],
  export: ["./kizuki", "export", "--out", "/absolute/backup", "--vault", "/absolute/workspace"],
  restoreVerify: ["./kizuki", "restore", "--from", "/absolute/backup", "--verify"],
  restore: ["./kizuki", "restore", "--from", "/absolute/backup", "--into", "/absolute/restored"],
} as const;

export function packagedCommandLine(argv: readonly string[]): string {
  return `  ${argv.join(" ")}`;
}

export function packagedQuickStart(input: { version: string; target: ReleaseTarget; sourceSha: string }): string {
  return [
    `Kizuki ${input.version} (${input.target.target})`,
    "",
    "This local package contains Kizuki, its dependencies and the Bun runtime",
    `for ${input.target.description}. It is an unsigned, unpublished candidate;`,
    "check BUILD.json against the accompanying exact-source native proof receipt.",
    "LICENSE covers Kizuki; THIRD-PARTY-NOTICES.txt records bundled material",
    "and unresolved notice/source information. Distribution has not been assessed.",
    "",
    "Verify the package files before running either executable:",
    `  ${input.target.checksum_command}`,
    "",
    "Keep both executables together in their final folder before setup.",
    "Use a graphical desktop with a default web browser. Linux requires",
    "/usr/bin/xdg-open (usually supplied by xdg-utils); macOS uses /usr/bin/open.",
    "Bun, Node and an external compiler are not required to run this package.",
    "In a terminal, change to this folder before running the command below.",
    "Open guided setup in your browser:",
    packagedCommandLine(PACKAGED_CLI_COMMANDS.app),
    "",
    "Choose your workspace, then open Sources and start with a local Markdown",
    "folder. Review its permissions before capturing anything. Setup enables",
    "background activity by default when a supported user service manager is",
    "available. Setup options lets you opt out; Settings shows the current state.",
    "Enter the full path to an existing notes folder outside the new workspace.",
    "If the browser cannot open, check the desktop session and default browser",
    "and retry. --no-open is diagnostic; its printed address does not sign you in.",
    "",
    "Terminal setup without a browser or background service:",
    packagedCommandLine(PACKAGED_CLI_COMMANDS.init),
    packagedCommandLine(PACKAGED_CLI_COMMANDS.import),
    packagedCommandLine(PACKAGED_CLI_COMMANDS.query),
    packagedCommandLine(PACKAGED_CLI_COMMANDS.doctor),
    "",
    "A model is optional. import and query work with none configured. doctor then",
    "reports canon writing: off. This package does not write memory pages without",
    "a model. There is no kizuki capture or kizuki search verb.",
    "To organise memory pages, choose a model in Settings, test the connection, then allow",
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
    packagedCommandLine(PACKAGED_CLI_COMMANDS.serveInstall),
    "",
    "Stop the current daemon instance without removing the service or workspace:",
    packagedCommandLine(PACKAGED_CLI_COMMANDS.serveStop),
    "Stop queues a request; it does not by itself prove the process has exited.",
    "The supervisor may restart the service according to its policy.",
    "There is no serve start verb; --install activates the current executable.",
    "",
    "Remove the background service and keep the workspace and captured evidence:",
    packagedCommandLine(PACKAGED_CLI_COMMANDS.serveUninstall),
    "Uninstall does not delete the workspace.",
    "",
    "Backup and restore into a new empty directory:",
    packagedCommandLine(PACKAGED_CLI_COMMANDS.export),
    packagedCommandLine(PACKAGED_CLI_COMMANDS.restoreVerify),
    packagedCommandLine(PACKAGED_CLI_COMMANDS.restore),
    "Export needs a source grant that includes the export purpose. restore --verify",
    "writes nothing. restore --into requires an empty target.",
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
    `  https://github.com/Illuminfti/kizuki/blob/${input.sourceSha}/docs/local-app.md`,
    "Backup, restore and diagnostics:",
    `  https://github.com/Illuminfti/kizuki/blob/${input.sourceSha}/docs/cli.md`,
    "Legacy extraction recovery:",
    `  https://github.com/Illuminfti/kizuki/blob/${input.sourceSha}/docs/extraction-recovery.md`,
  ].join("\n") + "\n";
}

if (import.meta.main) {
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
    writeFileSync(resolve(staging, "README.txt"), packagedQuickStart({ version, target: selected, sourceSha }), "utf8");
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
}
