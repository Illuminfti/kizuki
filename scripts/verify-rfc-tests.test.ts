import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RFC_0002_REL,
  RfcTestInventoryError,
  extractNamedRfcTestPaths,
  verifyRfcTestInventory,
} from "./verify-rfc-tests";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const NAMED = [
  "packages/core/test/canon/write-capability.test.ts",
  "packages/core/test/loop/budget.test.ts",
  "packages/tui/test/audit.test.ts",
] as const;

function rfcText(paths: readonly string[], heading = "## 15. CI invariants as concrete tests"): string {
  return [
    "# RFC\n",
    `${heading}\n`,
    ...paths.map((path) => `**\`${path}\`**\n`),
    "\n## 16. Worked examples\n",
    "ignore `packages/core/test/loop/budget.test.ts` here\n",
  ].join("\n");
}

function tree(paths: readonly string[], rfc = rfcText(paths)) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-rfc-tests-"));
  dirs.push(root);
  mkdirSync(join(root, "rfcs"), { recursive: true });
  writeFileSync(join(root, RFC_0002_REL), rfc);
  for (const path of paths) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "test.ok();\n");
  }
  return root;
}

test("a synthetic repository containing the required files passes", () => {
  const root = tree(NAMED);
  expect(verifyRfcTestInventory(root)).toEqual([...NAMED]);
});

test("removing packages/core/test/loop/budget.test.ts fails by that path", () => {
  const root = tree(NAMED);
  rmSync(join(root, "packages/core/test/loop/budget.test.ts"));
  expect(() => verifyRfcTestInventory(root)).toThrow(RfcTestInventoryError);
  try {
    verifyRfcTestInventory(root);
  } catch (error) {
    expect((error as Error).message).toContain("packages/core/test/loop/budget.test.ts");
  }
});

test("missing or malformed section 15 fails", () => {
  expect(() => extractNamedRfcTestPaths("# RFC\n\n## 16. Worked examples\n")).toThrow(
    /missing section 15/,
  );
  expect(() => extractNamedRfcTestPaths(rfcText([], "## 15. CI invariants as concrete tests"))).toThrow(
    /named no test files/,
  );
});

test("duplicate named entries fail", () => {
  expect(() => extractNamedRfcTestPaths(rfcText([NAMED[0], NAMED[0]]))).toThrow(/duplicates/);
});

test("a directory masquerading as a named test file fails", () => {
  const root = tree(NAMED);
  rmSync(join(root, NAMED[2]));
  mkdirSync(join(root, NAMED[2]));
  expect(() => verifyRfcTestInventory(root)).toThrow(/not regular files/);
});

test("the live checkout has every RFC 0002 named suite", () => {
  const paths = verifyRfcTestInventory(process.cwd());
  expect(paths).toContain("packages/core/test/loop/budget.test.ts");
  expect(paths).toHaveLength(21);
});
