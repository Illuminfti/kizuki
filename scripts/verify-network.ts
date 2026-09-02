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
}

export interface Partition {
  violations: NetworkFinding[];
  allowed: NetworkFinding[];
  stale: string[];
}

export const ALLOWLIST_PATH = "scripts/network-allowlist.txt";

/**
 * One `<repo-relative path>:<reason>` per line. The reason is what a reviewer
 * reads to decide whether the egress is still justified, so it may not be
 * empty; a path may appear once so two reasons can never disagree.
 */
export function parseAllowlist(text: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const cut = line.indexOf(":");
    if (cut === -1) {
      throw new Error(`allowlist line ${index + 1}: expected <path>:<reason>`);
    }
    const path = line.slice(0, cut).trim();
    const reason = line.slice(cut + 1).trim();
    if (path.length === 0) {
      throw new Error(`allowlist line ${index + 1}: empty path`);
    }
    if (reason.length === 0) {
      throw new Error(`allowlist line ${index + 1}: empty reason for ${path}`);
    }
    if (seen.has(path)) {
      throw new Error(`allowlist line ${index + 1}: duplicate path ${path}`);
    }
    seen.add(path);
    entries.push({ path, reason });
  }
  return entries;
}

/**
 * A stale entry is an exception nothing uses any more: the path is untracked
 * or has no network finding. Stale entries fail the gate so the list never
 * grows past what actually leaves the machine.
 */
export function partitionFindings(
  findings: NetworkFinding[],
  allowlist: AllowlistEntry[],
  tracked: ReadonlySet<string>,
): Partition {
  const allowedPaths = new Set(allowlist.map((entry) => entry.path));
  const violations: NetworkFinding[] = [];
  const allowed: NetworkFinding[] = [];
  const hit = new Set<string>();
  for (const finding of findings) {
    if (allowedPaths.has(finding.file)) {
      allowed.push(finding);
      hit.add(finding.file);
    } else {
      violations.push(finding);
    }
  }
  const stale = allowlist
    .map((entry) => entry.path)
    .filter((path) => !tracked.has(path) || !hit.has(path));
  return { violations, allowed, stale };
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

async function readAllowlist(): Promise<AllowlistEntry[]> {
  const file = Bun.file(ALLOWLIST_PATH);
  return (await file.exists()) ? parseAllowlist(await file.text()) : [];
}

function location(finding: NetworkFinding): string {
  return `${finding.file}:${finding.line}:${finding.column}: ${finding.reason}`;
}

async function main(): Promise<void> {
  const tracked = await trackedSourceFiles();
  const findings: NetworkFinding[] = [];
  for (const file of tracked) {
    findings.push(...scanSourceText(file, await Bun.file(file).text()));
  }
  const allowlist = await readAllowlist();
  const reasons = new Map(allowlist.map((entry) => [entry.path, entry.reason]));
  const partition = partitionFindings(findings, allowlist, new Set(tracked));

  for (const finding of partition.allowed) {
    console.error(
      `allowed: ${location(finding)} (${reasons.get(finding.file) ?? ""})`,
    );
  }
  for (const finding of partition.violations) console.error(location(finding));
  for (const path of partition.stale) {
    console.error(`stale allowlist entry: ${path}`);
  }
  if (partition.violations.length > 0 || partition.stale.length > 0) {
    process.exitCode = 1;
    return;
  }
  const files = new Set(partition.allowed.map((finding) => finding.file)).size;
  console.log(
    `network source verification passed (${partition.allowed.length} allowlisted findings in ${files} files)`,
  );
}

if (import.meta.main) {
  await main();
}
