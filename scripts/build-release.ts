import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const version = (await Bun.file(resolve(root, "packages/cli/package.json")).json() as {
  version: string;
}).version;
const target = process.env.KIZUKI_TARGET ?? "bun-linux-x64-baseline";

if (target !== "bun-linux-x64-baseline") {
  throw new Error(`unsupported release target: ${target}`);
}

const output = resolve(root, "dist", `kizuki-${version}`, target);
mkdirSync(output, { recursive: true });

const binaries = [
  { entrypoint: "packages/cli/src/main.ts", name: "kizuki" },
  { entrypoint: "packages/mcp/src/bin.ts", name: "kizuki-mcp" },
] as const;

for (const binary of binaries) {
  const result = await Bun.build({
    entrypoints: [resolve(root, binary.entrypoint)],
    compile: {
      target,
      outfile: resolve(output, binary.name),
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    define: { KIZUKI_COMPILED: "true" },
  });
  if (!result.success) {
    throw new Error(`could not compile ${binary.name}: ${result.logs.join("\n")}`);
  }
}

const checksumLines = binaries.map(({ name }) => {
  const digest = createHash("sha256").update(readFileSync(resolve(output, name))).digest("hex");
  return `${digest}  ${name}`;
});
writeFileSync(resolve(output, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
writeFileSync(
  resolve(output, "README.txt"),
  [
    `Kizuki ${version} — ${target}`,
    "",
    "This local package contains self-contained Bun executables for Linux x86_64",
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

process.stdout.write(`${dirname(output)}/${basename(output)}\n`);
