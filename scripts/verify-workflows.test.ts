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
  for (const runtime of ["1.3.10", "1.4.0"]) {
    expect(validateToolchain(undefined, runtime)).toEqual([
      expect.objectContaining({ reason: "verification requires Bun 1.3.14" }),
    ]);
  }
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
    const lock = readFileSync(join(root, "bun.lock"), "utf8").replace('"bun-types@1.3.14"', '"bun-types@1.4.0"');
    writeFileSync(join(root, "bun.lock"), lock);
    expect(validateToolchain(root).some(failure => failure.reason.includes("resolved Bun"))).toBe(true);
    writeFileSync(join(root, "package.json"), "{");
    expect(validateToolchain(root)).toEqual([expect.objectContaining({ reason: "toolchain metadata is missing or malformed" })]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const pinnedRef = '${{ github.event.pull_request.head.sha || github.sha }}';
const pinnedCheckout = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const pinnedBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const pinnedUpload = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const successIf = '${{ success() }}';
const linuxArtifactName = 'linux-x64-${{ github.event.pull_request.head.sha || github.sha }}';
const linuxReceiptPath = '${{ runner.temp }}/kizuki-artifact-proof/receipt.json';

function ciWorkflow(overrides?: {
  name?: string;
  extraJob?: string;
  testSteps?: string;
}): string {
  const name = overrides?.name ?? "ci";
  const testSteps = overrides?.testSteps ??
    `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0, ref: "${pinnedRef}" }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.14 }
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
      - run: |
          bun run build:release
          bun run smoke:release
          bun run proof:artifact -- --report "$RUNNER_TEMP/kizuki-artifact-proof"
      - run: bun scripts/ci-diff-check.ts
      - run: test -f "$RUNNER_TEMP/kizuki-artifact-proof/receipt.json"
      - if: ${successIf}
        uses: ${pinnedUpload}
        with:
          name: ${linuxArtifactName}
          path: |
            dist/kizuki-*/bun-linux-x64-baseline/
            ${linuxReceiptPath}
          retention-days: 7
          if-no-files-found: error
${overrides?.extraJob ?? ""}`;
}

describe("workflow validation", () => {
  test("the real workflow cannot disconnect the event-bound gate or restore mutable checkout refs", () => {
    const path = ".github/workflows/ci.yml";
    const current = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
    const old = current.replaceAll("          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n", "")
      .replace("run: bun scripts/ci-diff-check.ts", "run: |\n          git fetch --no-tags origin main\n          git diff --check FETCH_HEAD...HEAD");
    expect(validateWorkflowText(path, old).some(failure => failure.reason.includes("event head"))).toBe(true);
    expect(validateWorkflowText(path, old).some(failure => failure.reason.includes("event-bound diff"))).toBe(true);
    const skipped = current.replace("      - name: exact-head diff integrity", "      - if: false\n        name: exact-head diff integrity");
    expect(validateWorkflowText(path, skipped).some(failure => failure.reason.includes("event-bound diff"))).toBe(true);
    const secondCheckout = current.replace("      - name: secret patterns", `      - uses: ${pinnedCheckout}\n        with: { fetch-depth: 0, ref: main }\n      - name: secret patterns`);
    expect(validateWorkflowText(path, secondCheckout).some(failure => failure.reason.includes("event head"))).toBe(true);
  });

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
        with: { fetch-depth: 0, ref: "${pinnedRef}" }
      - run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("unpinned action") }),
    ]);
  });

  test("rejects a verify job without fetch-depth 0", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 1, ref: "${pinnedRef}" }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.14 }
      - run: bun run verify`,
    });
    expect(validateWorkflowText(".github/workflows/ci.yml", text)).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("fetch-depth"),
      }),
      expect.objectContaining({ reason: expect.stringContaining("event head") }),
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
        with: { fetch-depth: 0, ref: "${pinnedRef}" }
      - run: bun test
`;
    expect(validateWorkflowText(".github/workflows/ci.yml", withoutTest)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('job "test"') }),
    ]);
  });

  test("rejects skip-on-missing hashFiles conditions", () => {
    const text = ciWorkflow({
      testSteps: `      - uses: ${pinnedCheckout}
        with: { fetch-depth: 0, ref: "${pinnedRef}" }
      - uses: ${pinnedBun}
        with: { bun-version: 1.3.14 }
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
        with: { fetch-depth: 0, ref: "${pinnedRef}" }
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


test("manual macOS proof refuses automatic triggers, unbounded cost, and mutable checkouts", () => {
  const path = ".github/workflows/macos-native.yml";
  const text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  expect(validateWorkflowText(path, text)).toEqual([]);
  for (const bad of [text.replace("  workflow_dispatch:", "  push: {}\n  workflow_dispatch:"), text.replace("default: false", "default: true"), text.replace("timeout-minutes: 15", "timeout-minutes: 60"), text.replace("${{ github.event.pull_request.head.sha || github.sha }}", "main"), text.replace("bun scripts/ci-diff-check.ts", "echo skipped")]) {
    expect(validateWorkflowText(path, bad).length).toBeGreaterThan(0);
  }
});

test("macOS validator rejects removal or bypass of each native proof obligation", () => {
  const path = ".github/workflows/macos-native.yml";
  const text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  const mutations: [string, (doc: any) => void][] = [
    ["shallow checkout", d => { d.jobs["native-arm64"].steps[0].with["fetch-depth"] = 1; }],
    ["platform tests removed", d => { d.jobs["native-arm64"].steps.splice(5, 1); }],
    ["build proof removed", d => { d.jobs["native-arm64"].steps.splice(6, 1); }],
    ["wrong target", d => { d.jobs["native-arm64"].env.KIZUKI_TARGET = "bun-linux-x64-baseline"; }],
    ["host assertions removed", d => { d.jobs["native-arm64"].steps[4].run = "bun install --frozen-lockfile"; }],
    ["upload removed", d => { d.jobs["native-arm64"].steps.pop(); }],
    ["retention removed", d => { delete d.jobs["native-arm64"].steps[8].with["retention-days"]; }],
    ["receipt omitted", d => { d.jobs["native-arm64"].steps[8].with.path = "dist/kizuki-*/bun-darwin-arm64/"; }],
    ["Bun setup removed", d => { d.jobs["native-arm64"].steps.splice(2, 1); }],
    ["conditional tests", d => { d.jobs["native-arm64"].steps[5].if = "false"; }],
    ["conditional build", d => { d.jobs["native-arm64"].steps[6].if = "false"; }],
    ["masked proof failure", d => { d.jobs["native-arm64"].steps[6].run += "\ntrue"; }],
    ["target overridden in step", d => { d.jobs["native-arm64"].steps[6].env = { KIZUKI_TARGET: "bun-linux-x64-baseline" }; }],
    ["receipt check removed", d => { d.jobs["native-arm64"].steps.splice(7, 1); }],
    ["renamed receipt check", d => { d.jobs["native-arm64"].steps[7].run = 'test -f "$RUNNER_TEMP/kizuki-macos-artifact-proof/missing.json"'; }],
    ["wrong receipt path", d => { d.jobs["native-arm64"].steps[8].with.path = "dist/kizuki-*/bun-darwin-arm64/\n${{ runner.temp }}/wrong/receipt.json"; }],
    ["always() retention", d => { d.jobs["native-arm64"].steps[8].if = "${{ always() }}"; }],
    ["action SHA drift", d => { d.jobs["native-arm64"].steps[8].uses = "actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }],
    ["artifact name change", d => { d.jobs["native-arm64"].steps[8].with.name = "macos-arm64-latest"; }],
    ["package path change", d => { d.jobs["native-arm64"].steps[8].with.path = "dist/\n${{ runner.temp }}/kizuki-macos-artifact-proof/receipt.json"; }],
    ["retention-days change", d => { d.jobs["native-arm64"].steps[8].with["retention-days"] = 90; }],
    ["if-no-files-found change", d => { d.jobs["native-arm64"].steps[8].with["if-no-files-found"] = "warn"; }],
    ["proof-command removal", d => { d.jobs["native-arm64"].steps[6].run = "bun run build:release\nbun run smoke:release"; }],
    ["conditional receipt check", d => { d.jobs["native-arm64"].steps[7].if = "false"; }],
    ["adapter-only input removed", d => { delete d.on.workflow_dispatch.inputs.native_adapter_only; }],
    ["adapter canary removed", d => { d.jobs["native-arm64"].steps.splice(9, 1); }],
    ["adapter canary command weakened", d => { d.jobs["native-arm64"].steps[9].run = "bun run typecheck"; }],
    ["adapter canary receipt check removed", d => { d.jobs["native-arm64"].steps.splice(10, 1); }],
    ["adapter receipt upload condition weakened", d => { d.jobs["native-arm64"].steps[11].if = "${{ always() }}"; }],
    ["adapter receipt upload path changed", d => { d.jobs["native-arm64"].steps[11].with.path = "dist/"; }],
  ];
  for (const [name, mutate] of mutations) {
    const doc = Bun.YAML.parse(text); mutate(doc);
    expect(validateWorkflowText(path, JSON.stringify(doc)).length, name).toBeGreaterThan(0);
  }
});

test("Linux validator rejects removal or bypass of each native receipt retention binding", () => {
  const path = ".github/workflows/ci.yml";
  const text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  expect(validateWorkflowText(path, text)).toEqual([]);
  const mutations: [string, (doc: any) => void][] = [
    ["proof-command removal", d => { d.jobs.test.steps.splice(5, 1); }],
    ["receipt check removed", d => { d.jobs.test.steps.splice(7, 1); }],
    ["renamed receipt check", d => { d.jobs.test.steps[7].run = 'test -f "$RUNNER_TEMP/kizuki-artifact-proof/missing.json"'; }],
    ["package-only upload path", d => { d.jobs.test.steps[8].with.path = "dist/kizuki-*/bun-linux-x64-baseline/"; }],
    ["wrong receipt path", d => { d.jobs.test.steps[8].with.path = "dist/kizuki-*/bun-linux-x64-baseline/\n${{ runner.temp }}/wrong/receipt.json"; }],
    ["always() retention", d => { d.jobs.test.steps[8].if = "${{ always() }}"; }],
    ["action SHA drift", d => { d.jobs.test.steps[8].uses = "actions/upload-artifact@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }],
    ["artifact name change", d => { d.jobs.test.steps[8].with.name = "linux-x64-latest"; }],
    ["package path change", d => { d.jobs.test.steps[8].with.path = "dist/\n${{ runner.temp }}/kizuki-artifact-proof/receipt.json"; }],
    ["retention-days change", d => { d.jobs.test.steps[8].with["retention-days"] = 90; }],
    ["if-no-files-found change", d => { d.jobs.test.steps[8].with["if-no-files-found"] = "warn"; }],
    ["upload removed", d => { d.jobs.test.steps.pop(); }],
    ["conditional receipt check", d => { d.jobs.test.steps[7].if = "false"; }],
    ["masked proof failure", d => { d.jobs.test.steps[5].run += "\ntrue"; }],
    ["second package-only upload", d => {
      d.jobs.test.steps.push({
        name: "retain package only",
        if: "${{ always() }}",
        uses: pinnedUpload,
        with: {
          name: "linux-x64-extra",
          path: "dist/kizuki-*/bun-linux-x64-baseline/",
          "retention-days": 7,
          "if-no-files-found": "error",
        },
      });
    }],
    ["insert a benign run step between the receipt check and upload", d => {
      d.jobs.test.steps.splice(8, 0, { run: "true" });
    }],
    ["move the exact-head check after upload", d => {
      d.jobs.test.steps.push(d.jobs.test.steps.splice(6, 1)[0]);
    }],
    ["append a benign step after upload", d => {
      d.jobs.test.steps.push({ run: "true" });
    }],
    ["add workflow-level run defaults", d => {
      d.defaults = { run: { shell: "bash" } };
    }],
    ["add jobs.test run defaults", d => {
      d.jobs.test.defaults = { run: { shell: "bash" } };
    }],
  ];
  for (const [name, mutate] of mutations) {
    const doc = Bun.YAML.parse(text); mutate(doc);
    expect(validateWorkflowText(path, JSON.stringify(doc)).length, name).toBeGreaterThan(0);
  }
});


test("both native modes require ledger lifetime, imports and service custody consumer proofs", () => {
  const path = ".github/workflows/macos-native.yml";
  const text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  expect(validateWorkflowText(path, text)).toEqual([]);
  for (const [job, index] of [["native-arm64", 5], ["native-service", 4]] as const) {
    for (const proof of [" packages/core/test/export-portable-local.test.ts", " packages/cli/test/portable-connection-integrity.test.ts", " packages/cli/test/restore-connection-state.test.ts", " scripts/release-download.test.ts", " scripts/native-sqlite-vendor.test.ts", " packages/core/test/migration.test.ts", " packages/core/test/retrieval/fts5.test.ts", " packages/core/test/retrieval/fts5-erasure.test.ts", " packages/core/test/ledger-wal.test.ts", " packages/core/test/serve/boot-id.test.ts", " packages/cli/test/serve/restart.test.ts", " packages/core/test/descriptor-custody.test.ts", " packages/core/test/ledger-lifetime.test.ts", " packages/connector-ics/test/ingest-completion.test.ts", " packages/connectors/test/fleet-markdown-lifecycle.test.ts", " packages/cli/test/import-markdown-lifecycle.test.ts", " packages/core/test/ledger-identity.test.ts", " packages/cli/test/vault-identity.test.ts", " packages/cli/test/serve/supervisor-status.test.ts", " packages/core/test/serve/supervisor.test.ts", " packages/cli/test/rebuild.test.ts", " packages/core/test/serve/custody-native.test.ts", " packages/core/test/serve/custody-observation.test.ts", " packages/core/test/serve/custody.test.ts", " packages/cli/test/serve/custody.test.ts"]) {
      const doc = Bun.YAML.parse(text) as any;
      const step = doc.jobs[job].steps[index];
      expect(step.run, job).toContain(proof);
      step.run = step.run.replace(proof, "");
      expect(validateWorkflowText(path, JSON.stringify(doc)).some(failure => failure.reason.includes("macOS proof")), job).toBe(true);
    }
  }
});

test("native lifecycle mode cannot lose a host, source binding, supervisor gate or retained failure receipt", () => {
  const path = ".github/workflows/macos-native.yml";
  const current = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  const mutations = [
    (doc: any) => { doc.jobs["native-service"].strategy.matrix.os = ["ubuntu-24.04"]; },
    (doc: any) => { doc.jobs["native-service"]["timeout-minutes"] = 60; },
    (doc: any) => { doc.jobs["native-service"].if = "${{ true }}"; },
    (doc: any) => { doc.jobs["native-service"].steps[0].with.ref = "main"; },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("packages/cli/test/app-model-journey.test.ts", ""); },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("packages/cli/test/app-privacy-races.test.ts", ""); },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("packages/core/test/serve/stop-control.test.ts", ""); },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("packages/cli/test/serve-stop.test.ts", ""); },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("packages/core/test/agents/enrollment-preview.test.ts", ""); },
    (doc: any) => { doc.jobs["native-service"].steps[4].run = doc.jobs["native-service"].steps[4].run.replace("realpathSync", "String"); },
    (doc: any) => { doc.jobs["native-service"].steps[5].run += "\nsystemctl --user stop unrelated.service"; },
    (doc: any) => { doc.jobs["native-service"].steps[6].run = doc.jobs["native-service"].steps[6].run.split("\n").slice(0, 3).join("\n"); },
    (doc: any) => { doc.jobs["native-service"].steps[7].run = doc.jobs["native-service"].steps[7].run.replace("--baseline-artifact", "--unverified-baseline"); },
    (doc: any) => { doc.jobs["native-service"].steps[7].run += " || true"; },
    (doc: any) => { doc.jobs["native-service"].steps[8].if = "${{ success() }}"; },
    (doc: any) => { doc.jobs["native-service"].steps[8].with.path = "${{ runner.temp }}/**"; },
  ];
  for (const mutate of mutations) {
    const doc = Bun.YAML.parse(current);
    mutate(doc);
    expect(validateWorkflowText(path, JSON.stringify(doc)).some(failure => failure.reason.includes("macOS proof"))).toBe(true);
  }
});


test("paired native qualification retains exactly the built package and both receipts", () => {
  const path = ".github/workflows/macos-native.yml";
  const current = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  expect(validateWorkflowText(path, current)).toEqual([]);
  for (const missing of ["bun run smoke:release", 'bun run proof:artifact -- --report "$RUNNER_TEMP/kizuki-native-artifact-proof"']) {
    const doc = Bun.YAML.parse(current) as any;
    doc.jobs["native-service"].steps[6].run = doc.jobs["native-service"].steps[6].run.replace(missing, "");
    expect(validateWorkflowText(path, JSON.stringify(doc)).length).toBeGreaterThan(0);
  }
  for (const missing of ["dist/kizuki-*/bun-linux-x64-baseline/", "dist/kizuki-*/bun-darwin-arm64/", "${{ runner.temp }}/kizuki-native-artifact-proof/receipt.json", "${{ runner.temp }}/kizuki-native-service-lifecycle/receipt.json"]) {
    const doc = Bun.YAML.parse(current) as any;
    doc.jobs["native-service"].steps[8].with.path = doc.jobs["native-service"].steps[8].with.path.replace(missing, "");
    expect(validateWorkflowText(path, JSON.stringify(doc)).length).toBeGreaterThan(0);
  }
  const doc = Bun.YAML.parse(current) as any;
  doc.jobs["native-service"].steps[8].with.path += "\n${{ runner.temp }}/kizuki-native-artifact-proof/execution/";
  expect(validateWorkflowText(path, JSON.stringify(doc)).length).toBeGreaterThan(0);
});
