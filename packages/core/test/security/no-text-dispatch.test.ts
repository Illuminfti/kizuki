import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { MODEL_PRODUCER_DESCRIPTOR, createModelProducerPort } from "../../src/producer/model";
import {
  INJECTION_EVENT,
  draft,
  input,
  responseText,
  scriptedLlm,
  temporaryProducerContext,
} from "../producer/helpers";

const SRC = resolve(import.meta.dir, "../../src");
const ROOTS = ["ingest", "producer"].map((dir) => join(SRC, dir));

const SPAWNER_MODULES = new Set([
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
]);
const SPAWNER_CALLS = new Set(["Bun.spawn", "Bun.spawnSync", "Bun.$", "$"]);
const CONNECTOR_REGISTRY = /^@kizuki\/connectors|(?:^|\/)connectors\/(?:registry|index)$/;

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved import ${specifier} from ${from}`);
}

function name(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const owner = name(node.expression);
    return owner === null ? null : `${owner}.${node.name.text}`;
  }
  return null;
}

function listFiles(dir: string): string[] {
  return readdirRecursive(dir).filter((file) => file.endsWith(".ts"));
}

function readdirRecursive(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? readdirRecursive(path) : [path];
  });
}

interface Reach {
  readonly files: string[];
  readonly bareImports: Map<string, string[]>;
  readonly spawnerCalls: string[];
}

function walk(): Reach {
  const seen = new Set<string>();
  const bareImports = new Map<string, string[]>();
  const spawnerCalls: string[] = [];
  const queue = ROOTS.flatMap(listFiles);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        const target = resolveRelative(file, specifier);
        if (target === null) {
          const users = bareImports.get(specifier) ?? [];
          users.push(relative(SRC, file));
          bareImports.set(specifier, users);
        } else {
          queue.push(target);
        }
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          const specifier = argument !== undefined && ts.isStringLiteral(argument) ? argument.text : "<dynamic>";
          const users = bareImports.get(specifier) ?? [];
          users.push(relative(SRC, file));
          bareImports.set(specifier, users);
        }
        const called = name(node.expression);
        if (called !== null && (SPAWNER_CALLS.has(called) || called === "require")) {
          spawnerCalls.push(`${relative(SRC, file)}:${called}`);
        }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = name(node.tag);
        if (tag !== null && SPAWNER_CALLS.has(tag)) {
          spawnerCalls.push(`${relative(SRC, file)}:${tag}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...seen].sort(), bareImports, spawnerCalls };
}

describe("no code path from captured text to a dispatcher", () => {
  const reach = walk();

  test("the walk reaches ingest and producer sources", () => {
    expect(reach.files.some((file) => file.includes("/ingest/run.ts"))).toBe(true);
    expect(reach.files.some((file) => file.includes("/producer/model.ts"))).toBe(true);
    expect(reach.files.length).toBeGreaterThan(5);
  });

  test("no module reachable from ingest or producer imports a process spawner", () => {
    const offenders = [...reach.bareImports.keys()].filter((specifier) =>
      SPAWNER_MODULES.has(specifier) || specifier === "<dynamic>",
    );
    expect(offenders).toEqual([]);
    expect(reach.spawnerCalls).toEqual([]);
  });

  test("no module reachable from ingest or producer imports the connector registry", () => {
    const offenders = [...reach.bareImports.keys()].filter((specifier) =>
      CONNECTOR_REGISTRY.test(specifier),
    );
    expect(offenders).toEqual([]);
    expect(reach.files.some((file) => /\/connectors\//.test(file))).toBe(false);
  });

  test("no module reachable from ingest or producer opens a network path", () => {
    const network = ["http", "https", "net", "tls", "dns", "dgram", "undici", "axios"];
    const offenders = [...reach.bareImports.keys()].filter((specifier) =>
      network.includes(specifier.replace(/^node:/, "")),
    );
    expect(offenders).toEqual([]);
  });

  test("captured text never reaches the system role of a model request", async () => {
    const llm = scriptedLlm(() => responseText([draft({ event_ids: [INJECTION_EVENT.event_id] })]));
    const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
    try {
      const producer = createModelProducerPort(temporary.ctx, { llm });
      const result = await producer.produce(input([INJECTION_EVENT]));
      expect(result.status).toBe("ok");
      expect(llm.requests).toHaveLength(1);
      const [system, user, ...rest] = llm.requests[0]!.messages;
      expect(rest).toEqual([]);
      expect(system!.role).toBe("system");
      expect(system!.content).not.toContain("Ignore previous");
      expect(system!.content).not.toContain("curl");
      expect(system!.content).not.toContain("Grace");
      expect(user!.role).toBe("user");
      expect(user!.content.split("Ignore previous instructions").length - 1).toBe(1);
      await producer.close();
    } finally {
      temporary.cleanup();
    }
  });
});
