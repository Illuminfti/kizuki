import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { listConnectorDescriptors } from "@kizuki/connectors";

const ROOT = join(import.meta.dir, "../../..");
const PACKAGES = join(ROOT, "packages");

interface PackageJson {
  name?: unknown;
  exports?: unknown;
  bin?: unknown;
  module?: unknown;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function workspacePackages(): { dir: string; name: string; manifest: PackageJson }[] {
  const rows: { dir: string; name: string; manifest: PackageJson }[] = [];
  for (const entry of readdirSync(PACKAGES).sort()) {
    const dir = join(PACKAGES, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    expect(typeof manifest.name).toBe("string");
    rows.push({ dir, name: manifest.name as string, manifest });
  }
  return rows;
}

function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (exports === undefined || exports === null || Array.isArray(exports)) return [];
  if (typeof exports !== "object") return [];
  const paths: string[] = [];
  for (const value of Object.values(exports as Record<string, unknown>)) {
    if (typeof value === "string") paths.push(value);
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === "string") paths.push(nested);
      }
    }
  }
  return paths;
}

test("every workspace package.json name and export path exists", () => {
  const packages = workspacePackages();
  expect(packages.length).toBeGreaterThan(0);
  const names = packages.map((item) => item.name);
  expect(new Set(names).size).toBe(names.length);

  for (const item of packages) {
    expect(item.name.startsWith("@kizuki/")).toBe(true);
    for (const target of exportTargets(item.manifest.exports)) {
      expect(existsSync(join(item.dir, target))).toBe(true);
    }
    if (typeof item.manifest.module === "string") {
      expect(existsSync(join(item.dir, item.manifest.module))).toBe(true);
    }
    if (item.manifest.bin !== undefined && typeof item.manifest.bin === "object" && item.manifest.bin !== null) {
      for (const target of Object.values(item.manifest.bin as Record<string, unknown>)) {
        if (typeof target === "string") expect(existsSync(join(item.dir, target))).toBe(true);
      }
    }
  }
});

test("connector registry optional_package names resolve to workspace exports", () => {
  const packages = new Map(workspacePackages().map((item) => [item.name, item]));
  const descriptors = listConnectorDescriptors();
  expect(descriptors.length).toBeGreaterThan(0);

  for (const port of descriptors) {
    const spec = port.optional_package;
    expect(typeof spec).toBe("string");
    if (typeof spec !== "string" || spec.length === 0) continue;
    const match = packages.get(spec);
    if (match !== undefined) {
      expect(exportTargets(match.manifest.exports).length + (typeof match.manifest.module === "string" ? 1 : 0)).toBeGreaterThan(0);
      continue;
    }
    const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
    expect(slash).toBeGreaterThan(0);
    const name = spec.slice(0, slash);
    const subpath = `.${spec.slice(slash)}`;
    const pkg = packages.get(name);
    expect(pkg).toBeDefined();
    if (pkg === undefined) continue;
    const exports = pkg.manifest.exports;
    expect(exports !== null && typeof exports === "object" && !Array.isArray(exports)).toBe(true);
    expect((exports as Record<string, unknown>)[subpath]).toBeDefined();
  }
});

const STATUSES = new Set(["shipped", "designed", "direction"]);

interface CapabilityStatusEntry {
  id: string;
  status: string;
  doc: string;
  heading: string;
  implementation?: string;
  test?: string;
}

test("documentation status inventory maps shipped claims to live files", () => {
  const inventoryPath = join(ROOT, "docs/capability-status.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
    schema?: unknown;
    entries?: unknown;
  };
  expect(inventory.schema).toBe("kizuki.capability-status/v1");
  expect(Array.isArray(inventory.entries)).toBe(true);
  const entries = inventory.entries as CapabilityStatusEntry[];
  expect(entries.length).toBeGreaterThan(0);
  const ids = entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);

  for (const entry of entries) {
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
    expect(STATUSES.has(entry.status)).toBe(true);
    const docPath = join(ROOT, entry.doc);
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    expect(doc.includes(`## ${entry.heading}`)).toBe(true);
    if (entry.status === "shipped") {
      expect(typeof entry.implementation).toBe("string");
      expect(typeof entry.test).toBe("string");
      expect(existsSync(join(ROOT, entry.implementation!))).toBe(true);
      expect(existsSync(join(ROOT, entry.test!))).toBe(true);
    }
  }
});
