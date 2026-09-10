import ts from "typescript";

export interface NetworkFinding {
  file: string;
  line: number;
  column: number;
  reason: string;
  site: string;
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

function siteToken(value: string): string {
  return value.replaceAll(":", ".");
}

function enclosingSymbol(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name !== undefined &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (ts.isConstructorDeclaration(current)) return "constructor";
    if (ts.isFunctionExpression(current) && current.name !== undefined) {
      return current.name.text;
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return "(toplevel)";
}

class BindingScope {
  private readonly names = new Map<string, string | null>();
  constructor(private readonly parent: BindingScope | null = null) {}
  child(): BindingScope {
    return new BindingScope(this);
  }
  set(name: string, value: string | null): void {
    this.names.set(name, value);
  }
  lookup(name: string): string | null | undefined {
    if (this.names.has(name)) return this.names.get(name);
    return this.parent?.lookup(name);
  }
}

function resolvedNetworkApi(expr: ts.Expression, scope: BindingScope): string | null {
  const named = expressionName(expr);
  if (named !== null && networkCalls.has(named)) return named;
  if (ts.isIdentifier(expr)) {
    const bound = scope.lookup(expr.text);
    if (typeof bound === "string") return bound;
  }
  return null;
}

function bindFunctionName(node: ts.Node, scope: BindingScope): void {
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name !== undefined
  ) {
    scope.set(node.name.text, null);
  }
}

function bindParameters(node: ts.Node, scope: BindingScope): void {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isConstructorDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return;
  }
  for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name)) scope.set(parameter.name.text, null);
  }
}

function bindVariable(decl: ts.VariableDeclaration, scope: BindingScope): void {
  if (ts.isIdentifier(decl.name)) {
    const api =
      decl.initializer === undefined ? null : resolvedNetworkApi(decl.initializer, scope);
    scope.set(decl.name.text, api);
    return;
  }
  if (
    !ts.isObjectBindingPattern(decl.name) ||
    decl.initializer === undefined
  ) {
    return;
  }
  const owner = expressionName(decl.initializer);
  if (owner !== "globalThis" && owner !== "window" && owner !== "self") return;
  for (const element of decl.name.elements) {
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
    const prop = (() => {
      if (element.propertyName === undefined) return element.name.text;
      if (ts.isIdentifier(element.propertyName)) return element.propertyName.text;
      if (ts.isStringLiteral(element.propertyName) || ts.isNoSubstitutionTemplateLiteral(element.propertyName)) {
        return element.propertyName.text;
      }
      return null;
    })();
    if (prop === null) continue;
    const api = networkCalls.has(prop)
      ? prop
      : networkCalls.has(`${owner}.${prop}`)
        ? `${owner}.${prop}`
        : null;
    if (api !== null) scope.set(element.name.text, api);
  }
}

export function scanSourceText(file: string, source: string): NetworkFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind(file),
  );
  const pending: Array<Omit<NetworkFinding, "site"> & { base: string }> = [];

  const add = (node: ts.Node, reason: string, base: string): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    pending.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      reason,
      base,
    });
  };

  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);

  const visit = (node: ts.Node, scope: BindingScope): void => {
    bindFunctionName(node, scope);
    if (ts.isVariableDeclaration(node)) bindVariable(node, scope);

    const moduleName = importedModule(node);
    if (moduleName !== null && networkModules.has(moduleName)) {
      add(node, `network module import: ${moduleName}`, `${enclosingSymbol(node)}.import.${siteToken(moduleName)}`);
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const dynamicModule = staticString(node.arguments[0]);
        if (dynamicModule !== null && networkModules.has(dynamicModule)) {
          add(
            node,
            `dynamic network module import: ${dynamicModule}`,
            `${enclosingSymbol(node)}.import().${siteToken(dynamicModule)}`,
          );
        }
      } else {
        const called = expressionName(node.expression);
        const identifier = ts.isIdentifier(node.expression) ? node.expression : undefined;
        const shadowed = identifier !== undefined && scope.lookup(identifier.text) === null;
        if (!shadowed && called !== null && networkCalls.has(called)) {
          add(node, `network API call: ${called}`, `${enclosingSymbol(node)}.${siteToken(called)}`);
        }
        const aliased = identifier === undefined ? undefined : scope.lookup(identifier.text);
        if (identifier !== undefined && typeof aliased === "string") {
          add(
            node,
            `network API call: ${aliased}`,
            `${enclosingSymbol(node)}.${siteToken(identifier.text)}`,
          );
        }
        if (called === "require" || called === "process.getBuiltinModule") {
          const requiredModule = staticString(node.arguments[0]);
          if (requiredModule !== null && networkModules.has(requiredModule)) {
            add(
              node,
              `network module load: ${requiredModule}`,
              `${enclosingSymbol(node)}.${siteToken(called)}.${siteToken(requiredModule)}`,
            );
          }
        }
      }
    }

    if (ts.isNewExpression(node) && node.expression !== undefined) {
      const constructed = expressionName(node.expression);
      const identifier = ts.isIdentifier(node.expression) ? node.expression : undefined;
      const shadowed = identifier !== undefined && scope.lookup(identifier.text) === null;
      if (!shadowed && constructed !== null && networkCalls.has(constructed)) {
        add(
          node,
          `network API construction: ${constructed}`,
          `${enclosingSymbol(node)}.new.${siteToken(constructed)}`,
        );
      }
      const aliased = identifier === undefined ? undefined : scope.lookup(identifier.text);
      if (identifier !== undefined && typeof aliased === "string") {
        add(
          node,
          `network API construction: ${aliased}`,
          `${enclosingSymbol(node)}.new.${siteToken(identifier.text)}`,
        );
      }
    }

    const inner = isFunctionLike(node) ? scope.child() : scope;
    if (inner !== scope) bindParameters(node, inner);
    ts.forEachChild(node, (child) => visit(child, inner));
  };

  visit(sourceFile, new BindingScope());
  const counts = new Map<string, number>();
  return pending.map((item) => {
    const seen = (counts.get(item.base) ?? 0) + 1;
    counts.set(item.base, seen);
    return {
      file: item.file,
      line: item.line,
      column: item.column,
      reason: item.reason,
      site: `${item.base}#${seen}`,
    };
  });
}

export interface AllowlistEntry {
  path: string;
  site: string;
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
    const first = line.indexOf(":");
    if (first < 0) {
      throw new Error(`allowlist line ${index + 1} is missing ':'`);
    }
    const path = line.slice(0, first).trim();
    const rest = line.slice(first + 1);
    const second = rest.indexOf(":");
    if (second < 0) {
      throw new Error(`allowlist line ${index + 1} is missing a call-site fingerprint`);
    }
    const site = rest.slice(0, second).trim();
    const reason = rest.slice(second + 1).trim();
    if (path.length === 0 || site.length === 0 || reason.length === 0) {
      throw new Error(`allowlist line ${index + 1} has an empty path, site, or reason`);
    }
    const key = `${path}\0${site}`;
    if (seen.has(key)) {
      throw new Error(`allowlist line ${index + 1} duplicates ${path}:${site}`);
    }
    seen.add(key);
    entries.push({ path, site, reason, line: index + 1 });
  }
  return entries;
}

export function applyAllowlist(
  findings: NetworkFinding[],
  entries: AllowlistEntry[],
  trackedFiles: string[],
): TreeScan {
  const tracked = new Set(trackedFiles);
  const unused = new Map<string, NetworkFinding[]>();
  for (const finding of findings) {
    const current = unused.get(finding.file) ?? [];
    current.push(finding);
    unused.set(finding.file, current);
  }

  const allowlisted: TreeScan["allowlisted"] = [];
  const stale: AllowlistEntry[] = [];
  for (const entry of entries) {
    const remaining = unused.get(entry.path) ?? [];
    const matchIndex = remaining.findIndex((finding) => finding.site === entry.site);
    if (!tracked.has(entry.path) || matchIndex < 0) {
      stale.push(entry);
      continue;
    }
    const match = remaining[matchIndex]!;
    remaining.splice(matchIndex, 1);
    unused.set(entry.path, remaining);
    allowlisted.push({ entry, findings: [match] });
  }

  const remainingFindings: NetworkFinding[] = [];
  for (const leftover of unused.values()) remainingFindings.push(...leftover);
  return { findings: remainingFindings, allowlisted, stale };
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

async function trackedSourceFiles(cwd?: string): Promise<string[]> {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--"],
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `tracked-source producer exited ${result.exitCode}: ${result.stderr.toString()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => SOURCE_FILE.test(file));
}

export async function scanTrackedSources(opts?: {
  allowlistPath?: string;
  cwd?: string;
}): Promise<TreeScan> {
  const allowlistPath = opts?.allowlistPath ?? DEFAULT_ALLOWLIST_PATH;
  const cwd = opts?.cwd;
  const allowlistFile = Bun.file(
    cwd === undefined ? allowlistPath : `${cwd.replace(/\/$/, "")}/${allowlistPath}`,
  );
  if (!(await allowlistFile.exists())) {
    throw new Error(`network allowlist missing: ${allowlistPath}`);
  }
  const entries = parseAllowlist(await allowlistFile.text());
  const trackedFiles = await trackedSourceFiles(cwd);
  const findings: NetworkFinding[] = [];
  for (const file of trackedFiles) {
    const absolute = cwd === undefined ? file : `${cwd.replace(/\/$/, "")}/${file}`;
    findings.push(...scanSourceText(file, await Bun.file(absolute).text()));
  }
  return applyAllowlist(findings, entries, trackedFiles);
}

async function main(): Promise<void> {
  const scan = await scanTrackedSources();
  let failed = false;
  for (const finding of scan.findings) {
    console.error(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.site}: ${finding.reason}`,
    );
    failed = true;
  }
  for (const entry of scan.stale) {
    console.error(`stale allowlist entry: ${entry.path}:${entry.site} (line ${entry.line})`);
    failed = true;
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  for (const item of scan.allowlisted) {
    console.log(
      `allowlisted: ${item.entry.path}:${item.entry.site}: ${item.entry.reason}`,
    );
  }
  console.log(
    `network source verification passed (${scan.allowlisted.length} allowlisted call sites)`,
  );
}

if (import.meta.main) {
  await main();
}
