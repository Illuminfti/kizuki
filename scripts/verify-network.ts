import { join } from "node:path";
import ts from "typescript";

export interface NetworkFinding {
  file: string;
  line: number;
  column: number;
  reason: string;
}

const networkModules = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dns",
  "dgram",
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dns",
  "node:dgram",
  "axios",
  "undici",
]);

const networkCalls = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "globalThis.fetch",
  "globalThis.XMLHttpRequest",
  "globalThis.WebSocket",
  "globalThis.EventSource",
  "window.fetch",
  "window.XMLHttpRequest",
  "window.WebSocket",
  "window.EventSource",
  "self.fetch",
  "self.XMLHttpRequest",
  "self.WebSocket",
  "self.EventSource",
  "Bun.serve",
  "Bun.listen",
  "Bun.connect",
  "Deno.serve",
  "Deno.listen",
  "Deno.connect",
]);

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function staticString(node: ts.Expression | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function expressionName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const owner = expressionName(node.expression);
    return owner === null ? null : `${owner}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    const owner = expressionName(node.expression);
    const property = staticString(node.argumentExpression);
    return owner === null || property === null ? null : `${owner}.${property}`;
  }
  return null;
}

function importedModule(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return staticString(node.moduleSpecifier);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return staticString(node.moduleReference.expression);
  }
  return null;
}

export function scanSourceText(file: string, source: string): NetworkFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind(file),
  );
  const findings: NetworkFinding[] = [];

  const add = (node: ts.Node, reason: string): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      reason,
    });
  };

  const visit = (node: ts.Node): void => {
    const moduleName = importedModule(node);
    if (moduleName !== null && networkModules.has(moduleName)) {
      add(node, `network module import: ${moduleName}`);
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const dynamicModule = staticString(node.arguments[0]);
        if (dynamicModule !== null && networkModules.has(dynamicModule)) {
          add(node, `dynamic network module import: ${dynamicModule}`);
        }
      } else {
        const called = expressionName(node.expression);
        if (called !== null && networkCalls.has(called)) {
          add(node, `network API call: ${called}`);
        }
        if (called === "require" || called === "process.getBuiltinModule") {
          const requiredModule = staticString(node.arguments[0]);
          if (requiredModule !== null && networkModules.has(requiredModule)) {
            add(node, `network module load: ${requiredModule}`);
          }
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const constructed = expressionName(node.expression);
      if (constructed !== null && networkCalls.has(constructed)) {
        add(node, `network API construction: ${constructed}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export interface AllowlistEntry {
  path: string;
  reason: string;
  line: number;
}

export interface TreeScan {
  /** Findings in files that are not allowlisted; any of these fails the gate. */
  findings: NetworkFinding[];
  allowlisted: { entry: AllowlistEntry; findings: NetworkFinding[] }[];
  /** Entries that no longer describe a real, still-networked source file. */
  stale: AllowlistEntry[];
}

const sourcePath = /^packages\/[^/]+\/src\//;
const testPath = /^packages\/[^/]+\/test\//;

/** A test may be allowlisted only when its reason says it is a test. */
function isAllowlistablePath(entry: AllowlistEntry): boolean {
  return (
    sourcePath.test(entry.path) ||
    (testPath.test(entry.path) && entry.reason.startsWith("test:"))
  );
}

export function parseAllowlist(text: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  const claimed = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = (lines[index] ?? "").trim();
    if (raw.length === 0 || raw.startsWith("#")) continue;
    const separator = raw.indexOf(":");
    if (separator === -1) {
      throw new Error(
        `network allowlist line ${line}: expected "<path>:<reason>"`,
      );
    }
    const path = raw.slice(0, separator).trim();
    const reason = raw.slice(separator + 1).trim();
    if (path.length === 0) {
      throw new Error(`network allowlist line ${line}: empty path`);
    }
    if (reason.length === 0) {
      throw new Error(`network allowlist line ${line}: empty reason`);
    }
    if (claimed.has(path)) {
      throw new Error(`network allowlist line ${line}: duplicate path ${path}`);
    }
    claimed.add(path);
    entries.push({ path, reason, line });
  }
  return entries;
}

export function applyAllowlist(
  findings: NetworkFinding[],
  entries: AllowlistEntry[],
  trackedFiles: string[],
): TreeScan {
  const tracked = new Set(trackedFiles);
  const byPath = new Map<string, NetworkFinding[]>();
  for (const finding of findings) {
    const existing = byPath.get(finding.file);
    if (existing === undefined) byPath.set(finding.file, [finding]);
    else existing.push(finding);
  }

  const allowed = new Set<string>();
  const allowlisted: TreeScan["allowlisted"] = [];
  const stale: AllowlistEntry[] = [];
  for (const entry of entries) {
    const owned = byPath.get(entry.path) ?? [];
    if (
      !tracked.has(entry.path) ||
      !isAllowlistablePath(entry) ||
      owned.length === 0
    ) {
      stale.push(entry);
      continue;
    }
    allowed.add(entry.path);
    allowlisted.push({ entry, findings: owned });
  }

  return {
    findings: findings.filter((finding) => !allowed.has(finding.file)),
    allowlisted,
    stale,
  };
}

/**
 * An entry reaches `stale` for exactly one of three reasons, tested in the
 * order `applyAllowlist` tests them, so a tracked and allowlistable entry can
 * only be here because nothing in the file touches the network any more.
 */
function staleReason(entry: AllowlistEntry, tracked: Set<string>): string {
  if (!tracked.has(entry.path)) return "not a tracked source file";
  if (!isAllowlistablePath(entry)) {
    return 'outside packages/<pkg>/src, and not a packages/<pkg>/test entry with a "test:" reason';
  }
  return "no network surface left in the file";
}

/** Every tracked source file in the workspace packages. */
async function trackedSourceFiles(): Promise<string[]> {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", "packages"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `tracked-source producer exited ${result.exitCode}: ${result.stderr.toString()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file));
}

interface Scan {
  scan: TreeScan;
  tracked: Set<string>;
}

async function scanTree(allowlistPath: string): Promise<Scan> {
  const allowlistFile = Bun.file(allowlistPath);
  if (!(await allowlistFile.exists())) {
    throw new Error(`network allowlist missing: ${allowlistPath}`);
  }
  const entries = parseAllowlist(await allowlistFile.text());
  const trackedFiles = await trackedSourceFiles();
  const findings: NetworkFinding[] = [];
  for (const file of trackedFiles) {
    findings.push(...scanSourceText(file, await Bun.file(file).text()));
  }
  return {
    scan: applyAllowlist(findings, entries, trackedFiles),
    tracked: new Set(trackedFiles),
  };
}

const defaultAllowlistPath = join(import.meta.dir, "network-allowlist.txt");

export async function scanTrackedSources(
  opts: { allowlistPath?: string } = {},
): Promise<TreeScan> {
  return (await scanTree(opts.allowlistPath ?? defaultAllowlistPath)).scan;
}

async function main(): Promise<void> {
  const { scan, tracked } = await scanTree(defaultAllowlistPath);
  for (const finding of scan.findings) {
    console.error(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.reason}`,
    );
  }
  for (const entry of scan.stale) {
    console.error(
      `stale allowlist entry: ${entry.path} (${staleReason(entry, tracked)})`,
    );
  }
  if (scan.findings.length > 0 || scan.stale.length > 0) {
    process.exitCode = 1;
    return;
  }
  for (const { entry, findings: owned } of scan.allowlisted) {
    console.log(
      `allowlisted: ${entry.path} (${owned.length} findings): ${entry.reason}`,
    );
  }
  console.log(
    `network source verification passed (${scan.allowlisted.length} allowlisted files)`,
  );
}

if (import.meta.main) {
  await main();
}
