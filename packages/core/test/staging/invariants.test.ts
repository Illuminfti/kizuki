import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Architecture invariant 3: nothing writes canon except an owner-invoked
 * promote. A type alone cannot hold that line — a caller can erase it with a
 * cast — so this suite reads the source and asserts the shape of the code:
 * `invokedBy` exists only in the promote module, is only ever the literal
 * "owner", and is only ever supplied by `ownerPromote`.
 */

// The gate holds workspace-wide, not just in core: a raw promote() call added
// in the CLI or connectors packages must fail this suite too.
const PACKAGES = join(import.meta.dir, "..", "..", "..");
const SRC = join(PACKAGES, "core", "src");
const PROMOTE = join(SRC, "staging", "promote.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

const files = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PACKAGES, entry.name, "src"))
  .filter((srcDir) => {
    try {
      return readdirSync(srcDir).length >= 0;
    } catch {
      return false;
    }
  })
  .flatMap(sourceFiles)
  .sort();
const promoteSource = readFileSync(PROMOTE, "utf8");

/** Everything from `export function ownerPromote` to its closing brace. */
function ownerPromoteBody(): string {
  const start = promoteSource.indexOf("export function ownerPromote");
  expect(start).toBeGreaterThan(-1);
  const end = promoteSource.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return promoteSource.slice(start, end + 2);
}

describe("the promote path is the only door to canon", () => {
  test("the source tree is actually being scanned", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(PROMOTE);
  });

  test("invokedBy appears in the promote module and nowhere else", () => {
    const carriers = files.filter((file) =>
      /\binvokedBy\b/.test(readFileSync(file, "utf8")),
    );
    expect(carriers.map((f) => relative(PACKAGES, f))).toEqual([
      join("core", "src", "staging", "promote.ts"),
    ]);
  });

  test("every invokedBy value in the source is the literal owner", () => {
    const assignments = [
      ...promoteSource.matchAll(/invokedBy\s*:\s*([^,;}\n]+)/g),
    ].map((m) => (m[1] ?? "").trim());
    expect(assignments.length).toBeGreaterThan(0);
    for (const value of assignments) {
      expect(value).toBe('"owner"');
    }
  });

  test("the option type pins the gate to the literal owner", () => {
    expect(/invokedBy:\s*"owner";/.test(promoteSource)).toBe(true);
  });

  test("promote guards the gate at runtime, not only in the type", () => {
    expect(/opts\.invokedBy\s*!==\s*"owner"/.test(promoteSource)).toBe(true);
  });

  test("exactly one call site passes the owner stamp, inside ownerPromote", () => {
    // The `;` form is the type declaration; anything else is a value passed.
    expect(
      promoteSource.match(/invokedBy\s*:\s*"owner"(?!\s*;)/g),
    ).toHaveLength(1);
    expect(
      ownerPromoteBody().match(/invokedBy\s*:\s*"owner"(?!\s*;)/g),
    ).toHaveLength(1);
  });

  test("no other module calls promote", () => {
    const callers = files.filter(
      (file) =>
        file !== PROMOTE &&
        /(?<![A-Za-z0-9_.])promote\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(callers.map((f) => relative(PACKAGES, f))).toEqual([]);
  });

  test("the public staging surface exposes ownerPromote, not promote", () => {
    const barrel = readFileSync(join(SRC, "staging", "index.ts"), "utf8");
    expect(barrel).toContain("ownerPromote");
    // `promote` as an export specifier, as opposed to the "./promote" path.
    expect(/[{,]\s*promote\s*[,}]/.test(barrel)).toBe(false);
  });
});
