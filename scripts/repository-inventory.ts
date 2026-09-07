import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultConnectorRegistry } from "../packages/connectors/src/registry";

const root = join(import.meta.dir, "..");

/** Read workspace manifests and registered IDs without constructing connectors. */
export function repositoryInventory(): string {
  const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const manifests = new Set<string>();
  for (const pattern of workspace.workspaces) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root, absolute: true })) {
      manifests.add(file);
    }
  }
  const packages = [...manifests].sort().map((file) => {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { name: string };
    return `| \`${manifest.name}\` | [\`${relative(root, file)}\`](../${relative(root, file)}) |`;
  });
  const connectors = defaultConnectorRegistry.ids().map((id) => `| \`${id}\` |`);
  return [
    `## Workspace packages (${packages.length})`, "",
    "| Package | Manifest |", "| --- | --- |", ...packages, "",
    `## Registered connectors (${connectors.length})`, "",
    "| Connector ID |", "| --- |", ...connectors, "",
  ].join("\n");
}

if (import.meta.main) process.stdout.write(repositoryInventory());
