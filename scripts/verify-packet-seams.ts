import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { WORLD_OPS } from "../packages/core/src/world/public";
import { WORLD_CLI_OPS } from "../packages/cli/src/commands/world/ops";
import { MCP_WORLD_OPS } from "../packages/mcp/src/world/ops";
import { WORLD_REGISTRY } from "../packages/core/src/contracts/world-vocabulary";

const SURFACE_FILES = {
  core: ["packages/core/src/world/public.ts"],
  cli: ["packages/cli/src/commands/world.ts"],
  mcp: ["packages/mcp/src/world/surface.ts"],
  http: ["packages/core/src/serve/http.ts"],
  app: ["packages/cli/src/app/host.ts"],
} as const;

function fail(message: string): never {
  throw new Error(`packet seams: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected a row");
  return value as Record<string, unknown>;
}

function requiredFile(root: string, path: unknown): string {
  if (typeof path !== "string" || path === "" || isAbsolute(path) || path.includes("\\") || path.split("/").includes(".."))
    fail("expected a repository-relative file");
  try {
    if (!lstatSync(join(root, path)).isFile()) fail(`not a regular file: ${path}`);
  } catch {
    fail(`missing regular file: ${path}`);
  }
  return path;
}

/** Operator rails expose Core and CLI, without adding a world-view transport. */
function verifyOperatorSeams(root: string, row: Record<string, unknown>, key: string): void {
  for (const surface of ["core", "cli"]) {
    const entries = row[surface];
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.trim() === ""))
      fail(`${key} is missing ${surface}`);
  }
  for (const surface of ["mcp", "http", "app"])
    if (row[surface] !== undefined) fail(`${key} cannot declare ${surface}`);
  if (!Array.isArray(row.implementation) || row.implementation.length === 0) fail(`${key} needs implementation files`);
  for (const path of row.implementation) requiredFile(root, path);
  requiredFile(root, row.docs);
}

/** The shared scaffold accepts append-only workstream rows, with explicit paths when needed. */
export function verifyPacketSeams(root: string, input: unknown): number {
  if (!Array.isArray(input) || input.length === 0) fail("expected a nonempty packet table");
  const seen = new Set<string>();
  for (const value of input) {
    const row = record(value);
    const operator = row.kind === "operator";
    if (operator) {
      if (typeof row.packet !== "string" || !/^[A-Z][A-Z0-9-]{0,47}$/.test(row.packet)) fail("an operator row needs a packet id");
    } else if (!Number.isSafeInteger(row.packet) || (row.packet as number) <= 0 || typeof row.workstream !== "string" || row.workstream === "")
      fail("a row needs a packet and workstream");
    const key = operator ? `operator:${row.packet}` : `${row.packet}:${row.workstream}`;
    if (seen.has(key)) fail(`duplicate ${key}`);
    seen.add(key);
    if (operator) verifyOperatorSeams(root, row, key);
    else {
      if (typeof row.scope !== "string" || row.scope === "") fail(`${key} needs its implemented scope`);
      const seams = row.seams === undefined ? SURFACE_FILES : record(row.seams);
      for (const surface of Object.keys(SURFACE_FILES) as (keyof typeof SURFACE_FILES)[]) {
        if (typeof row[surface] !== "string" || row[surface] === "") fail(`${key} is missing ${surface}`);
        const paths = seams[surface];
        if (!Array.isArray(paths) || paths.length === 0) fail(`${key} needs ${surface} files`);
        for (const path of paths) requiredFile(root, path);
      }
    }
    if (!Array.isArray(row.tests) || row.tests.length === 0) fail(`${key} needs acceptance tests`);
    for (const test of row.tests) {
      const path = requiredFile(root, test);
      if (!path.endsWith(".test.ts") || !/\b(?:test|it)\s*\(/.test(readFileSync(join(root, path), "utf8")))
        fail(`${key} names a non-executable test: ${path}`);
    }
  }
  return input.length;
}

/** HTTP and App dispatch every Core operation; CLI and MCP have explicit registrations. */
export function verifyWorldSurfaceParity(
  ops = WORLD_OPS,
  cli = WORLD_CLI_OPS,
  mcp = MCP_WORLD_OPS,
): void {
  for (const op of ops) {
    if (!cli.some((entry) => entry.name === op.name && entry.cli !== null)) fail(`${op.name} lacks CLI`);
    if (!mcp.some((entry) => entry.name === op.name)) fail(`${op.name} lacks MCP`);
  }
  for (const kind of WORLD_REGISTRY.kinds)
    if (!ops.some((op) => op.dataSchemas.includes(kind.cardSchema))) fail(`${kind.id} lacks a card operation`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const rows = verifyPacketSeams(root, JSON.parse(readFileSync(join(root, "docs/world/packet-seams.json"), "utf8")));
  verifyWorldSurfaceParity();
  console.log(`packet seams: ${rows} rows verified`);
}
