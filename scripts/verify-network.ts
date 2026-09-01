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

async function main(): Promise<void> {
  const findings: NetworkFinding[] = [];
  for (const file of await trackedSourceFiles()) {
    findings.push(...scanSourceText(file, await Bun.file(file).text()));
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.file}:${finding.line}:${finding.column}: ${finding.reason}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("network source verification passed");
}

if (import.meta.main) {
  await main();
}
