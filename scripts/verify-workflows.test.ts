import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateToolchain,
  validateTrackedWorkflows,
  validateWorkflowText,
} from "./verify-workflows";

test("runtime, package metadata and resolved types share the checked-in Bun pin", () => {
  expect(validateToolchain()).toEqual([]);
  expect(validateToolchain(undefined, "1.4.0")).toEqual([
    expect.objectContaining({ reason: "verification requires Bun 1.3.10" }),
  ]);
  const root = mkdtempSync(join(tmpdir(), "kizuki-toolchain-"));
  try {
    for (const name of [".bun-version", "package.json", "bun.lock"]) {
      writeFileSync(join(root, name), readFileSync(resolve(import.meta.dir, "..", name)));
    }
    expect(validateToolchain(root)).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.devDependencies["@types/bun"] = "^1.3.0";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(validateToolchain(root).some(failure => failure.reason.includes("runtime types"))).toBe(true);
    const lock = readFileSync(join(root, "bun.lock"), "utf8").replace('"bun-types@1.3.10"', '"bun-types@1.4.0"');
    writeFileSync(join(root, "bun.lock"), lock);
    expect(validateToolchain(root).some(failure => failure.reason.includes("resolved Bun"))).toBe(true);
    writeFileSync(join(root, "package.json"), "{");
    expect(validateToolchain(root)).toEqual([expect.objectContaining({ reason: "toolchain metadata is missing or malformed" })]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const pinnedCheckout = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const pinnedBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

function ciWorkflow(overrides?: {
  name?: string;
  extraJob?: string;
  testSteps?: string;
}): string {
  const name = overrides?.name ?? "ci";
  const testSteps = overrides?.testSteps ??
    `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0 }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.10 }
      - run: bun run verify`;
  return `name: ${name}
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
${testSteps}
${overrides?.extraJob ?? ""}`;
}

describe("workflow validation", () => {
  test("accepts a SHA-pinned ci workflow with fetch-depth 0", () => {
    expect(validateWorkflowText(".github/workflows/ci.yml", ciWorkflow())).toEqual([]);
  });

  test("rejects invalid YAML", () => {
    const failures = validateWorkflowText(
      ".github/workflows/ci.yml",
      "name: ci\njobs: [\n",
    );
    expect(failures).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("invalid YAML") }),
    ]);
  });

  test("rejects an empty workflow file", () => {
    expect(validateWorkflowText(".github/workflows/ci.yml", "   \n")).toEqual([
      expect.objectContaining({ reason: "workflow file is empty" }),
    ]);
  });

  test("rejects a workflow with no jobs", () => {
    const failures = validateWorkflowText(
      ".github/workflows/other.yml",
      "name: other\non: [push]\njobs: {}\n",
    );
    expect(failures.some((failure) => failure.reason.includes("no jobs"))).toBe(true);
  });

  test("rejects continue-on-error", () => {
    const text = ciWorkflow({
      extraJob: `
  extra:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    continue-on-error: true
    steps:
      - run: echo extra`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("continue-on-error") }),
    ]);
  });

  test("rejects an unpinned action", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("unpinned action") }),
    ]);
  });

  test("rejects a verify job without fetch-depth 0", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 1 }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.10 }
      - run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("fetch-depth"),
      }),
    ]);
  });

  test("rejects renaming the ci workflow or its test job", () => {
    expect(
      validateWorkflowText(".github/workflows/ci.yml", ciWorkflow({ name: "checks" })),
    ).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('name must remain "ci"') }),
    ]);

    const withoutTest = `name: ci
on: [push]
jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0 }
      - run: bun test
`;
    expect(validateWorkflowText(".github/workflows/ci.yml", withoutTest)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('job "test"') }),
    ]);
  });

  test("rejects skip-on-missing hashFiles conditions", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0 }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.10 }
      - if: hashFiles('scripts/verify.sh') == ''
        run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("skip-on-missing") }),
    ]);
  });

  test("rejects bun-version latest", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0 }
      - uses: ${pinnedBun}
        with: { bun-version: latest }
      - run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("bun-version") }),
    ]);
  });

  test("the tracked workflow files pass the same rules CI runs", async () => {
    expect(await validateTrackedWorkflows()).toEqual([]);
  });
});
