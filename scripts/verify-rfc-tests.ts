import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const RFC_0002_REL = "rfcs/0002-autonomous-canon.md";

export class RfcTestInventoryError extends Error {
  override readonly name = "RfcTestInventoryError";
  constructor(message: string) {
    super(message);
  }
}

const TEST_ENTRY = /\*\*`([^`]+)`\*\*/g;

function fail(message: string): never {
  throw new RfcTestInventoryError(message);
}

export function extractNamedRfcTestPaths(rfcText: string): string[] {
  const start = rfcText.search(/^## 15\./m);
  if (start < 0) fail("RFC 0002 is missing section 15");
  const rest = rfcText.slice(start);
  const endMatch = rest.slice(1).search(/^## /m);
  const section = endMatch < 0 ? rest : rest.slice(0, endMatch + 1);
  const paths: string[] = [];
  for (const match of section.matchAll(TEST_ENTRY)) {
    const path = match[1] ?? "";
    if (!path.endsWith(".test.ts")) continue;
    paths.push(path);
  }
  if (paths.length === 0) fail("RFC 0002 section 15 named no test files");
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) fail(`RFC 0002 section 15 duplicates ${path}`);
    seen.add(path);
  }
  return paths;
}

function assertRepoRelative(path: string): void {
  if (path.length === 0 || isAbsolute(path) || path.split(/[/\\]/).includes("..")) {
    fail(`RFC 0002 section 15 path is not a repository-relative file: ${path}`);
  }
}

export function inspectRfcTestInventory(
  root: string,
  rfcText: string,
): { paths: string[]; missing: string[]; notFiles: string[] } {
  const paths = extractNamedRfcTestPaths(rfcText);
  const missing: string[] = [];
  const notFiles: string[] = [];
  for (const path of paths) {
    assertRepoRelative(path);
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      missing.push(path);
      continue;
    }
    if (!lstatSync(absolute).isFile()) notFiles.push(path);
  }
  return { paths, missing, notFiles };
}

export function verifyRfcTestInventory(root: string): string[] {
  const rfcPath = join(root, RFC_0002_REL);
  if (!existsSync(rfcPath) || !lstatSync(rfcPath).isFile()) {
    fail(`missing ${RFC_0002_REL}`);
  }
  const report = inspectRfcTestInventory(root, readFileSync(rfcPath, "utf8"));
  if (report.missing.length > 0) {
    fail(`missing RFC 0002 named tests:\n${report.missing.join("\n")}`);
  }
  if (report.notFiles.length > 0) {
    fail(`RFC 0002 named tests are not regular files:\n${report.notFiles.join("\n")}`);
  }
  return report.paths;
}

function main(): void {
  try {
    const paths = verifyRfcTestInventory(resolve(process.argv[2] ?? process.cwd()));
    console.log(`rfc test inventory passed (${paths.length} named suites)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "rfc test inventory failed";
    console.error(`verification failed: ${message}`);
    process.exitCode = error instanceof RfcTestInventoryError ? 1 : 2;
  }
}

if (import.meta.main) main();
