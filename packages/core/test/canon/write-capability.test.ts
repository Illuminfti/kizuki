import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import * as core from "../../src/index";
import * as contracts from "../../src/contracts/index";
import * as staging from "../../src/staging/index";
import { writePage } from "../../src/vault/write";
import { sourceFiles } from "./helpers";

/**
 * RFC 0002 §15. This file replaces the pre-RFC `staging/invariants.test.ts`
 * and is the tree's structural protection of the vault: the capability is a
 * type, a runtime brand, and a source scan, so a cast cannot erase it.
 */
const PACKAGES = resolve(import.meta.dir, "../../..");
const WRITE_MODULE = "core/src/vault/write.ts";
const WRITER_MODULE = "core/src/canon/apply.ts";
const STORE_ADAPTER = "core/src/canon/store";
const IMPORT_SPECIFIER = /^\s*(?:import|export)\b[^"';]*?["']([^"']+)["']/gm;

interface Source {
  path: string;
  text: string;
}

function readTree(kind: "src" | "test"): Source[] {
  const files: Source[] = [];
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const root = join(PACKAGES, pkg, kind);
    let isDirectory = false;
    try {
      isDirectory = statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    for (const rel of sourceFiles(root)) {
      files.push({
        path: `${pkg}/${kind}/${rel}`,
        text: readFileSync(join(root, rel), "utf8"),
      });
    }
  }
  return files;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Removes import and re-export statements, whatever their line layout. */
function stripBindings(code: string): string {
  return code
    .replace(/^\s*import\s+type\s[\s\S]*?["'][^"']+["'];?/gm, "")
    .replace(/^\s*import\s[\s\S]*?["'][^"']+["'];?/gm, "")
    .replace(/^\s*export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/gm, "");
}

/** Call sites of `name(`, excluding its own declaration. */
function callSites(source: Source, name: string): number {
  const code = stripBindings(stripComments(source.text)).replace(
    new RegExp(`function\\s+${name}\\s*\\(`, "g"),
    "",
  );
  return code.match(new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`, "g"))?.length ?? 0;
}

/** Top-level function bodies of a module, found by brace matching. */
function functionBodies(text: string): string[] {
  const code = stripComments(text);
  const bodies: string[] = [];
  const pattern = /^(?:export\s+)?(?:async\s+)?function\s+\w+/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const open = code.indexOf("{", match.index);
    if (open === -1) break;
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === "{") depth += 1;
      if (code[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(code.slice(match.index, index + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

const SRC = readTree("src");
const TESTS = readTree("test");

describe("canon write capability", () => {
  test("the source tree is actually being scanned", () => {
    const paths = SRC.map(({ path }) => path);
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toContain(WRITE_MODULE);
    expect(paths).toContain(WRITER_MODULE);
    expect(paths).toContain("core/src/canon/store.ts");
    expect(paths.some((path) => path.startsWith("cli/src/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("tui/src/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("connectors/src/"))).toBe(true);
    expect(TESTS.map(({ path }) => path)).toContain(
      "core/test/canon/write-capability.test.ts",
    );
    const writeModule = SRC.find(({ path }) => path === WRITE_MODULE);
    expect(callSites(writeModule as Source, "consume")).toBeGreaterThan(0);
  });

  test("grantCanonWrite is defined in vault/write.ts and called in exactly one module", () => {
    const definitions = SRC.filter(({ text }) =>
      /export\s+function\s+grantCanonWrite\s*\(/.test(stripComments(text)),
    ).map(({ path }) => path);
    expect(definitions).toEqual([WRITE_MODULE]);

    const callers = SRC.filter((source) => callSites(source, "grantCanonWrite") > 0).map(
      ({ path }) => path,
    );
    expect(callers).toEqual([WRITER_MODULE]);
  });

  test("writePage has no call site outside canon/apply.ts and its tests", () => {
    const srcCallers = SRC.filter((source) => callSites(source, "writePage") > 0).map(
      ({ path }) => path,
    );
    expect(srcCallers).toEqual([WRITER_MODULE]);

    const testCallers = TESTS.filter((source) => callSites(source, "writePage") > 0).map(
      ({ path }) => path,
    );
    expect(testCallers.length).toBeGreaterThan(0);
    for (const path of testCallers) {
      expect(path.startsWith("core/test/canon/")).toBe(true);
    }
  });

  test("CanonWriteCapability cannot be constructed outside vault/write.ts", () => {
    for (const source of SRC) {
      if (source.path === WRITE_MODULE) continue;
      const code = stripComments(source.text);
      expect(code).not.toMatch(/\[CAPABILITY\]/);
      expect(code).not.toMatch(/canon-write-capability/);
      expect(code).not.toMatch(/as\s+(?:unknown\s+as\s+)?CanonWriteCapability\b/);
      expect(code).not.toMatch(/satisfies\s+CanonWriteCapability\b/);
    }
    const writeModule = SRC.find(({ path }) => path === WRITE_MODULE) as Source;
    expect(writeModule.text).toMatch(/const CAPABILITY: unique symbol = Symbol\(/);
    expect(writeModule.text).not.toMatch(/export\s+(?:const|\{[^}]*\b)CAPABILITY\b/);

    let refused: unknown;
    try {
      writePage(
        Object.freeze({ writer: "loop", receipt_id: "forged" }) as never,
        join(import.meta.dir, "never-written.md"),
        { data: {}, body: "" },
      );
    } catch (error) {
      refused = error;
    }
    expect((refused as { reason?: string }).reason).toBe("capability_invalid");
  });

  test("every writePage call site passes a capability minted in the same function", () => {
    const writer = SRC.find(({ path }) => path === WRITER_MODULE) as Source;
    const bodies = functionBodies(writer.text);
    const writing = bodies.filter((body) => /(?<![A-Za-z0-9_$.])writePage\s*\(/.test(body));
    expect(writing.length).toBeGreaterThan(0);
    // Every call site sits inside a captured top-level function body, so none
    // hides in an arrow function or module-level statement the walk missed.
    const captured = writing.reduce(
      (sum, body) => sum + (body.match(/(?<![A-Za-z0-9_$.])writePage\s*\(/g)?.length ?? 0),
      0,
    );
    expect(captured).toBe(callSites(writer, "writePage"));
    for (const body of writing) {
      const mint = body.search(/(?<![A-Za-z0-9_$.])grantCanonWrite\s*\(/);
      const use = body.search(/(?<![A-Za-z0-9_$.])writePage\s*\(/);
      expect(mint).toBeGreaterThan(-1);
      expect(mint).toBeLessThan(use);
      expect(body).toMatch(/writePage\s*\(\s*cap\b/);
    }
    expect(callSites(writer, "grantCanonWrite")).toBe(writing.length);
    // No product function takes a capability as a parameter, so one cannot be
    // minted in apply.ts and handed onward for use elsewhere.
    for (const source of SRC) {
      expect(/:\s*CanonWriteCapability\b/.test(stripComments(source.text))).toBe(
        source.path === WRITE_MODULE,
      );
    }
  });

  test("the public core surface exports applyCanonWrite and not writePage", () => {
    expect(Object.keys(core)).toContain("applyCanonWrite");
    expect(Object.keys(core)).toContain("undoReceipt");
    expect(Object.keys(core)).not.toContain("writePage");
    expect(Object.keys(core)).not.toContain("grantCanonWrite");
    expect(Object.keys(core)).not.toContain("applyRevertWrite");
    expect(Object.keys(contracts)).not.toContain("writePage");
    expect(Object.keys(staging)).not.toContain("writePage");
    expect(Object.keys(staging)).not.toContain("grantCanonWrite");
    const index = SRC.find(({ path }) => path === "core/src/index.ts") as Source;
    expect(index.text).not.toMatch(/\bwritePage\b/);
    expect(index.text).not.toMatch(/\bgrantCanonWrite\b/);
  });

  test("no module outside canon/ imports the canon store adapter", () => {
    const importers = SRC.filter((source) =>
      [...stripComments(source.text).matchAll(IMPORT_SPECIFIER)].some((match) => {
        const specifier = match[1] as string;
        if (!specifier.startsWith(".")) return false;
        const target = posix.normalize(posix.join(posix.dirname(source.path), specifier));
        return target === STORE_ADAPTER || target === `${STORE_ADAPTER}.ts`;
      }),
    ).map(({ path }) => path);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers).toContain(WRITER_MODULE);
    for (const path of importers) {
      expect(path.startsWith("core/src/canon/")).toBe(true);
    }
    for (const source of SRC) {
      if (source.path.startsWith("core/src/canon/")) continue;
      expect(source.text).not.toMatch(/canon\/store["']/);
    }
  });
});
