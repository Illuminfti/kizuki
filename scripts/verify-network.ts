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
  findings: NetworkFinding[];
  allowlisted: { entry: AllowlistEntry; findings: NetworkFinding[] }[];
  stale: AllowlistEntry[];
}

const DEFAULT_ALLOWLIST_PATH = "scripts/network-allowlist.txt";

export function parseAllowlist(text: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      throw new Error(`allowlist line ${index + 1} is missing ':'`);
    }
    const path = line.slice(0, colon).trim();
    const reason = line.slice(colon + 1).trim();
    if (path.length === 0 || reason.length === 0) {
      throw new Error(`allowlist line ${index + 1} has an empty path or reason`);
    }
    if (seen.has(path)) {
      throw new Error(`allowlist line ${index + 1} duplicates path ${path}`);
    }
    seen.add(path);
    entries.push({ path, reason, line: index + 1 });
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
    const current = byPath.get(finding.file) ?? [];
    current.push(finding);
    byPath.set(finding.file, current);
  }

  const allowlisted: TreeScan["allowlisted"] = [];
  const stale: AllowlistEntry[] = [];
  const allowed = new Set<string>();
  for (const entry of entries) {
    const entryFindings = byPath.get(entry.path) ?? [];
    const outsidePackages = !entry.path.startsWith("packages/");
    if (!tracked.has(entry.path) || outsidePackages || entryFindings.length === 0) {
      stale.push(entry);
      continue;
    }
    allowed.add(entry.path);
    allowlisted.push({ entry, findings: entryFindings });
  }

  const remaining: NetworkFinding[] = [];
  for (const finding of findings) {
    if (!allowed.has(finding.file)) remaining.push(finding);
  }
  return { findings: remaining, allowlisted, stale };
}

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

export async function scanTrackedSources(opts?: {
  allowlistPath?: string;
}): Promise<TreeScan> {
  const allowlistPath = opts?.allowlistPath ?? DEFAULT_ALLOWLIST_PATH;
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
  return applyAllowlist(findings, entries, trackedFiles);
}

async function main(): Promise<void> {
  const scan = await scanTrackedSources();
  let failed = false;
  for (const finding of scan.findings) {
    console.error(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.reason}`,
    );
    failed = true;
  }
  for (const entry of scan.stale) {
    console.error(`stale allowlist entry: ${entry.path} (line ${entry.line})`);
    failed = true;
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  for (const item of scan.allowlisted) {
    console.log(
      `allowlisted: ${item.entry.path} (${item.findings.length} findings): ${item.entry.reason}`,
    );
  }
  console.log(
    `network source verification passed (${scan.allowlisted.length} allowlisted files)`,
  );
}

if (import.meta.main) {
  await main();
}
