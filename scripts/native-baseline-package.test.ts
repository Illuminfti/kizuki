import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUN_DISTRIBUTION_PIN } from "./release-notices";
import { checkNativeBaselineInputs, createNativeBaselineOutput, NATIVE_BASELINE_SOURCE_SHA, parseNativeBaselineArgs } from "./native-baseline-package";

const lock = "2726abbda9cc9466570398e4297132d00969fee68a8cc486c244ce31a4ab6224";
const candidate = { source: "a".repeat(40), clean: true, lock, bun: BUN_DISTRIBUTION_PIN.version, revision: BUN_DISTRIBUTION_PIN.revision };
test("baseline admission rejects wrong source, dirty input, changed dependency graph and unpinned runtime", () => {
  expect(() => checkNativeBaselineInputs(candidate, lock)).not.toThrow();
  for (const fault of [{ source: NATIVE_BASELINE_SOURCE_SHA }, { source: "bad" }, { clean: false },
    { lock: "b".repeat(64) }, { bun: "1.3.10" }, { revision: "bad" }]) {
    expect(() => checkNativeBaselineInputs({ ...candidate, ...fault }, lock)).toThrow();
  }
  expect(() => checkNativeBaselineInputs(candidate, "c".repeat(64))).toThrow();
});

test("baseline output refuses existing directories and alias parents without touching retained material", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-baseline-admission-"));
  try {
    const output = join(root, "existing"); mkdirSync(output); writeFileSync(join(output, "sentinel"), "preserve");
    expect(() => createNativeBaselineOutput(output)).toThrow();
    expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("preserve");
    symlinkSync(output, join(root, "alias"));
    expect(() => createNativeBaselineOutput(join(root, "alias", "child"))).toThrow();
    expect(existsSync(join(output, "child"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("baseline argv is closed and requires an explicit retained output", () => {
  expect(parseNativeBaselineArgs(["--out", "retained"])).toBe(resolve("retained"));
  for (const argv of [[], ["--out"], ["--out", ""], ["--out", "--bad"], ["--source", "other"], ["--out", "x", "--force"]])
    expect(() => parseNativeBaselineArgs(argv)).toThrow();
});
