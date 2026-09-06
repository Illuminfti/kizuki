import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { evaluateRelease, parseAcceptanceArgs, writeAcceptanceReport } from "./go-no-go";
import {
  CAPABILITY_PROOF_FILE, CONNECTORS, EVIDENCE_LIMITS, EvidenceError, JOURNEYS, SURFACE_DOC_FILES, SURFACE_GATE, SURFACE_PRODUCER, SURFACE_PRODUCER_FILES, TARGETS,
  cliVerbSequence, evaluateSurfaceReceipt, expectedSurfaceInventory, inspectOptionalVerifier, producerRevision, read,
} from "./release-evidence";
import { initQualification } from "./qualification";
import { initVault } from "../packages/core/src/vault/init";
import { openLedger } from "../packages/core/src/ledger/db";
import { initServe } from "../packages/core/src/serve/schema";
import { artifactProofSteps, SQLITE_ENGINE_POLICY } from "./artifact-proof";
import type { SqliteRuntime } from "../packages/core/src/ledger/runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const target = "bun-linux-x64-baseline";
function fixture(platform = target) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-acceptance-fixture-")); roots.push(root);
  const artifact = join(root, "artifact"); mkdirSync(artifact);
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  for (const name of names.slice(0, 3)) writeFileSync(join(artifact, name), `Synthetic ${name} evaluator fixture. Never executed.`);
  writeFileSync(join(artifact, "BUILD.json"), JSON.stringify({ schema: "kizuki.release-build/v1", source_sha: source, target: platform, bun_version: "1.3.14" }));
  writeFileSync(join(artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(artifact, name)))}  ${name}`).join("\n") + "\n");
  const execution = "/tmp/kizuki-artifact-proof-synthetic/execution", vault = `${execution}/vault`, restored = `${execution}/restored`, exported = `${execution}/export`;
  const commands: [string, string[]][] = [
    ["help", ["--help"]], ["init", ["init", vault, "--no-service"]],
    ["import", ["import", "markdown-folder", "--source", `${execution}/notes`, "--policy", `${execution}/source-policy.json`, "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", vault]],
    ["query", ["query", "Ada", "--vault", vault]], ["query-result", []],
    ["context", ["context", "--query", "Ada", "--vault", vault]], ["context-result", []],
    ["export", ["export", "--out", exported, "--vault", vault]], ["restore-verify", ["restore", "--from", exported, "--verify"]],
    ["restore", ["restore", "--from", exported, "--into", restored]],
    ["restored-query", ["query", "Ada", "--degraded", "--vault", restored]], ["restored-query-result", []],
    ["restored-context", ["context", "--query", "Ada", "--vault", restored]], ["restored-context-result", []],
  ];
  const receipt = {
    schema: "kizuki.artifact-proof/v1", source_sha: source, target: platform,
    host_platform: platform === target ? "linux" : "darwin", host_arch: platform === target ? "x64" : "arm64",
    binary_sha256: digest(readFileSync(join(artifact, "kizuki"))), bun_version: "1.3.14",
    package_sha256: Object.fromEntries([...names, "SHA256SUMS"].map(name => [name, digest(readFileSync(join(artifact, name)))])),
    paths: { executable: "/tmp/kizuki-artifact-proof-synthetic/artifact/kizuki", home: `${execution}/home`, config: `${execution}/config/kizuki.toml`, vault, restored_vault: restored },
    steps: commands.map(([id, args]) => ({ id, command: args.length ? ["kizuki", ...args] : ["assert", "fixture is recalled"], exit_code: 0, passed: true, timeout_ms: args.length ? 30000 : 0 })), failures: [] as string[],
  };
  const proof = join(root, "proof.json"), indexPath = join(root, "index.json");
  const ref = { producer: "kizuki.artifact-proof/v1", target: platform, directory: artifact, proof, proof_sha256: "" };
  const index = { schema: "kizuki.acceptance-evidence/v1", candidate_source_sha: source, artifacts: [ref], fixture_observation: null as unknown };
  const save = () => { writeFileSync(proof, JSON.stringify(receipt)); ref.proof_sha256 = digest(readFileSync(proof)); writeFileSync(indexPath, JSON.stringify(index)); };
  save(); return { root, artifact, proof, indexPath, index, receipt, ref, save };
}
function engineFixture(exit = 0, platform = target) {
  const f = fixture(platform), entry = SQLITE_ENGINE_POLICY.accepted[0];
  const runtime: SqliteRuntime = { schema: "kizuki.sqlite-runtime/v1", bun_version: "1.3.14",
    sqlite_version: entry.sqlite_version, sqlite_source_id: entry.sqlite_source_id };
  const receipt = Object.assign(f.receipt, { schema: "kizuki.artifact-proof/v2", host_kernel_release: "synthetic-kernel",
    engine_observations: {
      kizuki: { executable_sha256: f.receipt.package_sha256.kizuki!, runtime: { ...runtime }, exit_code: exit, doctor_status: exit === 0 ? "ok" : "error" },
      kizuki_mcp: { executable_sha256: f.receipt.package_sha256["kizuki-mcp"]!, runtime: { ...runtime }, exit_code: 0, mcp_is_error: false },
    },
  });
  receipt.steps = artifactProofSteps("kizuki.artifact-proof/v2", receipt.paths).map(step => ({ ...step, passed: true, exit_code: step.id === "cli-engine" ? exit : 0 }));
  f.ref.producer = receipt.schema; f.index.schema = "kizuki.acceptance-evidence/v2"; f.save();
  return { ...f, receipt };
}
const gate = (result: ReturnType<typeof evaluateRelease>, id: string) => result.gates.find(row => row.id === id)!;

test.each(["serialize", "write", "sync", "race"])("report publication keeps the final path intact across %s failure", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-report-publication-")); roots.push(root);
  const out = join(root, "report.json");
  // Fault injection stays inside a child, so other tests retain the real fs module.
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const write = fs.writeFileSync, sync = fs.fsyncSync;
    const mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(out)};
    let injected = false;
    mock.module("node:fs", () => ({ ...fs,
      writeFileSync(target, bytes, ...args) {
        if (mode === "write" && !injected) {
          injected = true; write(target, String(bytes).slice(0, 7), ...args); throw new Error("synthetic disk full");
        }
        return write(target, bytes, ...args);
      },
      fsyncSync(fd) {
        if (mode === "sync" && !injected) { injected = true; throw new Error("synthetic sync failure"); }
        if (mode === "race" && !injected) { injected = true; write(out, "competing report", { flag: "wx", mode: 0o600 }); }
        return sync(fd);
      },
    }));
    const { writeAcceptanceReport } = await import(${JSON.stringify(join(import.meta.dir, "go-no-go.ts"))});
    const report = mode === "serialize" ? { toJSON() { throw new Error("synthetic serialization failure"); } } : { synthetic: true };
    let failed = false;
    try { writeAcceptanceReport(out, report); } catch { failed = true; }
    process.stdout.write(JSON.stringify({ failed, files: fs.readdirSync(${JSON.stringify(root)}),
      final: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.failed).toBe(true);
  expect(result.files).toEqual(mode === "race" ? ["report.json"] : []);
  expect(result.final).toBe(mode === "race" ? "competing report" : null);
});

test.each(["unlink", "rmdir", "directory-sync"])("report publication identifies complete output after %s failure", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-report-postpublication-")); roots.push(root);
  const out = join(root, "report.json");
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const remove = fs.rmSync, rmdir = fs.rmdirSync, sync = fs.fsyncSync;
    const mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(out)};
    let directorySyncAttempted = false;
    mock.module("node:fs", () => ({ ...fs,
      rmSync(path, options) { if (mode === "unlink") throw new Error("synthetic cleanup failure"); return remove(path, options); },
      rmdirSync(path) { if (mode === "rmdir") throw new Error("synthetic cleanup failure"); return rmdir(path); },
      fsyncSync(fd) {
        if (fs.fstatSync(fd).isDirectory()) {
          directorySyncAttempted = true;
          if (mode === "directory-sync") throw new Error("synthetic directory sync failure");
        }
        return sync(fd);
      },
    }));
    const { writeAcceptanceReport } = await import(${JSON.stringify(join(import.meta.dir, "go-no-go.ts"))});
    let reason = null;
    try { writeAcceptanceReport(out, { synthetic: true }); } catch (error) { reason = error.reason ?? error.message; }
    process.stdout.write(JSON.stringify({ reason, directorySyncAttempted, final: JSON.parse(fs.readFileSync(out, "utf8")) }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.directorySyncAttempted).toBe(true);
  expect(result.final).toEqual({ synthetic: true });
  expect(result.reason).toBe(mode === "directory-sync" ? "published-report-durability-unconfirmed" : "published-report-cleanup-failed");
});

test("readiness keeps install, stranger and P0 evidence required while calendar observation stays optional", () => {
  const f = fixture(); f.index.artifacts = []; f.save();
  for (const profile of ["rc", "1.0"] as const) {
    const result = evaluateRelease(profile, f.indexPath);
    expect(result.decision).toBe("NO-GO"); expect(result.release_1_0_accepted).toBe(false);
    expect(result.gates.filter(row => row.id.startsWith("journey.")).map(row => row.id)).toEqual([
      "journey.connect-resume", "journey.correct-belief", "journey.revoke-purge", "journey.retrieve-trustworthily", "journey.import-estate-slice", "journey.daily-loop", "journey.useful-insight", "journey.install-recover",
    ]);
    expect(result.connectors).toHaveLength(15);
    expect(gate(result, `artifact.${target}`).status).toBe("MISSING");
    for (const id of ["owner.seven-day-rails", "estate.fourteen-day-parity", "owner.final-cutover"]) {
      expect(gate(result, id)).toMatchObject({ required: false, status: "NOT_IMPLEMENTED", reason: "superseded-readiness-gate" });
    }
    for (const id of [`artifact.${target}`, `lifecycle.${target}`, "journey.install-recover", "human.unfamiliar-user", "candidate.current-p0-disposition"]) {
      expect(gate(result, id).required).toBe(true);
      expect(gate(result, id).status).not.toBe("PASS");
    }
  }
});

test("consistent fixture bytes receive only local integrity credit, never native, human or release approval", () => {
  const f = fixture(), mac = fixture("bun-darwin-arm64"); f.index.artifacts.push(mac.ref); f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  expect(gate(result, "artifact.bun-darwin-arm64").status).toBe("PASS");
  expect(gate(result, `artifact.${target}`).scope).toBe("automated-fixture-integrity");
  expect(gate(result, `engine.${target}`)).toMatchObject({ required: true, status: "MISSING", reason: "missing-engine-proof" });
  expect(gate(result, `native.${target}`).status).toBe("UNVERIFIABLE");
  expect(gate(result, "human.unfamiliar-user").status).toBe("NOT_IMPLEMENTED");
  expect(result.decision).toBe("NO-GO");
  expect(result.evidence[0]!.producer_revision).toBeNull();
  expect(result.policy_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.verifier_sha256).toMatch(/^[a-f0-9]{64}$/);
  const output = JSON.stringify(result);
  expect(output).not.toContain(f.root); expect(output).not.toContain(f.receipt.paths.vault);
});

test.each([0, 1])("v2 engine records preserve doctor exit %d without granting native or release credit", exit => {
  const f = engineFixture(exit), mac = engineFixture(exit, "bun-darwin-arm64");
  f.index.artifacts.push(mac.ref); f.save();
  const result = evaluateRelease("1.0", f.indexPath);
  expect(result.schema).toBe("kizuki.acceptance-report/v2");
  for (const platform of [target, "bun-darwin-arm64"]) {
    expect(gate(result, `artifact.${platform}`).status).toBe("PASS");
    expect(gate(result, `engine.${platform}`)).toMatchObject({ required: true, status: "PASS", scope: "effective-sqlite-runtime" });
    expect(gate(result, `native.${platform}`).status).toBe("UNVERIFIABLE");
  }
  expect(result.decision).toBe("NO-GO");
  expect(result.release_1_0_accepted).toBe(false);
  for (const file of ["scripts/artifact-proof.ts", "scripts/artifact-engine.ts", "packages/core/src/ledger/runtime.ts"]) {
    expect(result.verifier.find(entry => entry.file === file)?.sha256).toBe(digest(readFileSync(join(import.meta.dir, "..", file))));
  }
});

test("v2 indexes may inventory v1 receipts without adding engine credit", () => {
  const f = fixture(); f.index.schema = "kizuki.acceptance-evidence/v2"; f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  expect(gate(result, `engine.${target}`).reason).toBe("missing-engine-proof");
  expect(gate(result, `engine.${target}`).status).toBe("MISSING");
});

test("producer versions must match their index and actual receipt", () => {
  const f = engineFixture(); f.index.schema = "kizuki.acceptance-evidence/v1"; f.save();
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
  f.index.schema = "kizuki.acceptance-evidence/v2"; f.ref.producer = "kizuki.artifact-proof/v1"; f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("FAIL");
  expect(gate(result, `engine.${target}`).status).toBe("FAIL");
});

test("matching unknown engines retain fixture consistency with a failing engine gate", () => {
  const f = engineFixture();
  for (const observation of Object.values(f.receipt.engine_observations)) observation.runtime.sqlite_source_id = "synthetic unqualified source";
  f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  expect(gate(result, `engine.${target}`)).toMatchObject({ status: "FAIL", reason: "unqualified-sqlite-identity" });
  expect(result.decision).toBe("NO-GO");
});

for (const [label, mutate] of [
  ["missing MCP observation", (f) => Object.assign(f.receipt.engine_observations, { kizuki_mcp: null })],
  ["wrong MCP executable", (f) => { f.receipt.engine_observations.kizuki_mcp.executable_sha256 = f.receipt.binary_sha256; }],
  ["different child Bun", (f) => { f.receipt.engine_observations.kizuki.runtime.bun_version = "9.9.9"; }],
  ["different child SQLite", (f) => { f.receipt.engine_observations.kizuki_mcp.runtime.sqlite_version = "3.53.1"; }],
  ["doctor outcome mismatch", (f) => { f.receipt.engine_observations.kizuki.doctor_status = "error"; }],
  ["engine step reordered", (f) => { [f.receipt.steps[2], f.receipt.steps[3]] = [f.receipt.steps[3]!, f.receipt.steps[2]!]; }],
] satisfies [string, (f: ReturnType<typeof engineFixture>) => unknown][]) test(`v2 artifact refuses ${label}`, () => {
  const f = engineFixture(); mutate(f); f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("FAIL");
  expect(gate(result, `engine.${target}`).status).toBe("FAIL");
});

test("duplicate receipt keys cannot establish either fixture or engine credit", () => {
  const f = engineFixture();
  const raw = `{"schema":"kizuki.artifact-proof/v2",${JSON.stringify(f.receipt).slice(1)}`;
  writeFileSync(f.proof, raw); f.ref.proof_sha256 = digest(raw); writeFileSync(f.indexPath, JSON.stringify(f.index));
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).reason).toBe("duplicate-json-key");
  expect(gate(result, `engine.${target}`).status).toBe("FAIL");
});

for (const [label, mutate] of [
  ["wrong candidate", (f: ReturnType<typeof fixture>) => { f.index.candidate_source_sha = "b".repeat(40); }],
  ["wrong native host", (f: ReturnType<typeof fixture>) => { f.receipt.host_platform = "darwin"; }],
  ["missing MCP identity", (f: ReturnType<typeof fixture>) => { delete f.receipt.package_sha256["kizuki-mcp"]; }],
  ["different MCP bytes", (f: ReturnType<typeof fixture>) => { appendFileSync(join(f.artifact, "kizuki-mcp"), "changed"); }],
  ["duplicate step", (f: ReturnType<typeof fixture>) => { f.receipt.steps[4] = f.receipt.steps[0]!; }],
  ["missing assertion", (f: ReturnType<typeof fixture>) => { f.receipt.steps.splice(4, 1); }],
  ["failed assertion", (f: ReturnType<typeof fixture>) => { f.receipt.steps[4]!.passed = false; f.receipt.steps[4]!.exit_code = 1; }],
  ["substituted command", (f: ReturnType<typeof fixture>) => { f.receipt.steps[1]!.command = ["kizuki", "--help"]; }],
  ["wrong timeout", (f: ReturnType<typeof fixture>) => { f.receipt.steps[0]!.timeout_ms = 0; }],
  ["failed earlier attempt", (f: ReturnType<typeof fixture>) => { f.receipt.failures.push("PRIVATE failure sentinel"); }],
  ["inconsistent isolated paths", (f: ReturnType<typeof fixture>) => { f.receipt.paths.home = f.receipt.paths.vault; }],
] as const) test(`artifact proof refuses ${label}`, () => {
  const f = fixture(); mutate(f); f.save();
  const result = evaluateRelease("1.0", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("FAIL");
  expect(result.decision).toBe("NO-GO"); expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("corruption, digest mismatch, duplicate keys and unknown fields fail without dropping required gates", () => {
  const f = fixture(); appendFileSync(f.proof, " ");
  expect(gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`).status).toBe("FAIL");
  for (const extra of ['"owner_authorized":true,', '"passed":true,', '"waive":["human.unfamiliar-user"],']) {
    writeFileSync(f.indexPath, `{${extra}${JSON.stringify(f.index).slice(1)}`);
    const result = evaluateRelease("rc", f.indexPath);
    expect(gate(result, "evidence.index").status).toBe("FAIL"); expect(result.gates.length).toBeGreaterThan(30);
  }
  writeFileSync(f.indexPath, `{"candidate_source_sha":"${"b".repeat(40)}",${JSON.stringify(f.index).slice(1)}`);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
});

test("duplicate target, unknown producer and fixture role promotion are rejected", () => {
  const f = fixture(); f.index.artifacts.push(f.ref); f.save();
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
  f.index.artifacts.pop(); f.ref.producer = "manual-pass/v1"; f.save();
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
  f.ref.producer = "kizuki.artifact-proof/v1";
  f.index.fixture_observation = { scope: "owner", observed_ms: 1209600000, owner_authorized: true, dates: Array.from({length: 14}, (_, i) => `day-${i}`) }; f.save();
  const result = evaluateRelease("1.0", f.indexPath);
  expect(gate(result, "evidence.index").status).toBe("FAIL"); expect(gate(result, "estate.fourteen-day-parity").status).toBe("NOT_IMPLEMENTED");
});

test("symlink leaves and parents, hardlinks, oversized and torn input are refused", () => {
  const f = fixture(), original = readFileSync(f.proof);
  rmSync(f.proof); symlinkSync(join(f.artifact, "BUILD.json"), f.proof);
  expect(gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`).status).toBe("FAIL");
  rmSync(f.proof); writeFileSync(f.proof, original); linkSync(f.proof, join(f.root, "hardlink"));
  expect(gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`).status).toBe("FAIL");
  rmSync(join(f.root, "hardlink")); truncateSync(f.proof, 1024 * 1024 + 1);
  expect(gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`).status).toBe("FAIL");
  symlinkSync(f.root, join(f.root, "alias"));
  expect(gate(evaluateRelease("rc", join(f.root, "alias", "index.json")), "evidence.index").status).toBe("FAIL");
  writeFileSync(f.indexPath, "{"); expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
});

test("CLI has no bypass flags, writes privately once and exits nonzero on a complete NO-GO report", () => {
  const f = fixture(), out = join(f.root, "result.json");
  expect(() => parseAcceptanceArgs(["--profile", "rc", "--evidence", f.indexPath, "--out", out, "--ignore", "human"])).toThrow();
  expect(() => parseAcceptanceArgs(["--profile", "rc", "--profile", "1.0", "--evidence", f.indexPath, "--out", out])).toThrow();
  const processResult = Bun.spawnSync([process.execPath, join(import.meta.dir, "go-no-go.ts"), "--profile", "rc", "--evidence", f.indexPath, "--out", out]);
  expect(processResult.exitCode).toBe(1); expect(processResult.stderr.toString()).toBe("");
  expect(JSON.parse(processResult.stdout.toString()).decision).toBe("NO-GO");
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const retained = readFileSync(out, "utf8");
  expect(() => writeAcceptanceReport(out, evaluateRelease("rc", f.indexPath))).toThrow();
  expect(readFileSync(out, "utf8")).toBe(retained);
});

test("original fixture observation is diagnostic only; copied, torn and substituted journals fail", () => {
  const f = fixture(), vault = join(f.root, "vault"), scope = join(f.root, "scope.json"), run = join(f.root, "run");
  initVault(vault); const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try { initServe(db); db.query("UPDATE schedules SET next_run_at = ?").run(new Date().toISOString()); } finally { db.close(); }
  writeFileSync(scope, JSON.stringify({ scope: "fixture", vault, brief_hour: 7, timezone: "UTC", supervisor: "none" }));
  initQualification(f.artifact, f.proof, scope, run);
  const ref = { producer: "kizuki.qualification/v1", directory: run, manifest_sha256: digest(readFileSync(join(run, "manifest.json"))), genesis_sha256: digest(readFileSync(join(run, "genesis.json"))), samples_sha256: digest(readFileSync(join(run, "samples.jsonl"))) };
  f.index.fixture_observation = ref; f.save();
  const result = evaluateRelease("1.0", f.indexPath);
  expect(gate(result, "diagnostic.fixture-observation").status).toBe("PASS");
  expect(result.fixture_observation?.observed_ms).toBe(0); expect(result.fixture_observation?.release_credit).toBe(false);
  expect(gate(result, "owner.seven-day-rails").status).toBe("NOT_IMPLEMENTED");
  expect(gate(result, "estate.fourteen-day-parity").status).toBe("NOT_IMPLEMENTED");
  expect(JSON.stringify(result)).not.toContain(vault);
  appendFileSync(join(run, "samples.jsonl"), "{");
  ref.samples_sha256 = digest(readFileSync(join(run, "samples.jsonl"))); f.save();
  expect(gate(evaluateRelease("1.0", f.indexPath), "diagnostic.fixture-observation").status).toBe("FAIL");
  writeFileSync(join(run, "samples.jsonl"), ""); ref.samples_sha256 = digest("");
  const copied = join(f.root, "copy"); mkdirSync(copied);
  for (const name of ["manifest.json", "genesis.json", "samples.jsonl"]) writeFileSync(join(copied, name), readFileSync(join(run, name)));
  ref.directory = copied; f.save();
  expect(gate(evaluateRelease("1.0", f.indexPath), "diagnostic.fixture-observation").status).toBe("FAIL");
});

test("numeric overflow, excessive nesting and oversized indexes cannot supply outcomes", () => {
  const f = fixture();
  const raw = readFileSync(f.proof, "utf8").replace('"timeout_ms":30000', '"timeout_ms":1e400');
  writeFileSync(f.proof, raw); f.ref.proof_sha256 = digest(raw); writeFileSync(f.indexPath, JSON.stringify(f.index));
  expect(gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`).status).toBe("FAIL");
  writeFileSync(f.indexPath, "[".repeat(100) + "0" + "]".repeat(100));
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
  truncateSync(f.indexPath, 16385);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
});

test("failed reads and mismatched evidence never report a caller-asserted digest as verified bytes", () => {
  const f = fixture(); f.ref.directory = join(f.root, "missing-artifact"); f.ref.proof_sha256 = "f".repeat(64);
  f.index.fixture_observation = { producer: "kizuki.qualification/v1", directory: join(f.root, "missing-run"), manifest_sha256: "f".repeat(64), genesis_sha256: "f".repeat(64), samples_sha256: "f".repeat(64) };
  writeFileSync(f.indexPath, JSON.stringify(f.index));
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, "evidence.index").status).toBe("PASS");
  expect(result.index_sha256).toBe(digest(readFileSync(f.indexPath)));
  for (const id of [`artifact.${target}`, "diagnostic.fixture-observation"]) {
    expect(gate(result, id).status).toBe("FAIL"); expect(gate(result, id).evidence_sha256).toBeNull();
  }
  f.ref.directory = f.artifact; f.index.fixture_observation = null; f.save(); appendFileSync(f.proof, " ");
  const mismatched = gate(evaluateRelease("rc", f.indexPath), `artifact.${target}`);
  expect(mismatched.status).toBe("FAIL"); expect(mismatched.evidence_sha256).toBeNull();
});

test.each(["1.3.10", "9.9.9"])("self-consistent packages with Bun %s are refused by the release policy and verifier identity", (version) => {
  const f = fixture();
  const build = JSON.parse(readFileSync(join(f.artifact, "BUILD.json"), "utf8")); build.bun_version = version;
  writeFileSync(join(f.artifact, "BUILD.json"), JSON.stringify(build));
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(f.artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(f.artifact, name)))}  ${name}`).join("\n") + "\n");
  for (const name of [...names, "SHA256SUMS"]) f.receipt.package_sha256[name] = digest(readFileSync(join(f.artifact, name)));
  f.receipt.bun_version = version; f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("FAIL");
  expect(gate(result, `artifact.${target}`).reason).toBe("unsupported-package-bun-version");
  expect(gate(result, `artifact.${target}`).evidence_sha256).toBeNull();
  expect(result.supported_bun_version).toBe(readFileSync(join(import.meta.dir, "../.bun-version"), "utf8").trim());
  expect(result.verifier.find(item => item.file === ".bun-version")?.sha256).toBe(digest(readFileSync(join(import.meta.dir, "../.bun-version"))));
});

function asV3(f: ReturnType<typeof fixture>, receipts: unknown[] = []) {
  Object.assign(f.index, { schema: "kizuki.acceptance-evidence/v3", gate_receipts: receipts });
  f.save();
  return f;
}
function receiptRef(producer: string, gate_id: string, target: string | null, path: string, sha256 = "a".repeat(64)) {
  return { producer, gate_id, target, path, sha256 };
}
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString().trim();
}
function surfaceCandidate() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-surface-candidate-")); roots.push(root);
  const repo = resolve(import.meta.dir, "..");
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "docs"));
  writeFileSync(join(root, ".bun-version"), readFileSync(join(repo, ".bun-version")));
  for (const name of SURFACE_DOC_FILES) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(join(repo, name), join(root, name));
  }
  writeFileSync(join(root, SURFACE_PRODUCER_FILES[0]), "export const SYNTHETIC_SURFACE_PRODUCER = true;\n");
  copyFileSync(join(repo, SURFACE_PRODUCER_FILES[1]), join(root, SURFACE_PRODUCER_FILES[1]));
  git(root, ["init"]); git(root, ["config", "user.email", "surface@example.test"]); git(root, ["config", "user.name", "surface"]);
  git(root, ["config", "commit.gpgsign", "false"]); git(root, ["add", "-A"]); git(root, ["commit", "-m", "synthetic surface candidate", "--no-gpg-sign"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  return { root, sha, expected: expectedSurfaceInventory(root, sha) };
}
function surfaceBody(expected: ReturnType<typeof expectedSurfaceInventory>, patch: Record<string, unknown> = {}) {
  return {
    schema: SURFACE_PRODUCER,
    identity: {
      candidate_source_sha: expected.head_sha, producer: SURFACE_PRODUCER, producer_revision: expected.producer_revision,
      producer_files: expected.producer_files, source_class: "candidate-tree-inventory", actor_class: "automated-producer",
      attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", recorded_at: "2026-09-06T00:00:00.000Z",
    },
    outcome: "pass", failures: [] as { code: string }[],
    head_sha: expected.head_sha, bun_version: expected.bun_version, cli_verbs: expected.cli_verbs,
    retired_verbs: expected.retired_verbs, mcp_tools: expected.mcp_tools,
    connectors_registered: expected.connectors_registered, connectors_c3: expected.connectors_c3, docs: expected.docs,
    disagreements: [] as { code: string; path: string }[],
    ...patch,
  };
}

test("v1 and v2 indexes remain valid after the v3 reader lands", () => {
  const v1 = fixture(), v2 = engineFixture();
  expect(gate(evaluateRelease("rc", v1.indexPath), "evidence.index").status).toBe("PASS");
  expect(gate(evaluateRelease("rc", v2.indexPath), `engine.${target}`).status).toBe("PASS");
  v1.index = { ...v1.index, gate_receipts: [] }; v1.save();
  expect(gate(evaluateRelease("rc", v1.indexPath), "evidence.index").status).toBe("FAIL");
});

test("v3 empty receipts keep artifact credit and do not implement new families", () => {
  const f = asV3(fixture());
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, "evidence.index").status).toBe("PASS");
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  expect(gate(result, SURFACE_GATE).status).toBe("NOT_IMPLEMENTED");
  expect(result.decision).toBe("NO-GO");
  expect(result.verifier.find(item => item.file === "scripts/release-evidence.ts")?.sha256).toBe(digest(readFileSync(join(import.meta.dir, "release-evidence.ts"))));
  expect(result.verifier.find(item => item.file === CAPABILITY_PROOF_FILE)).toEqual({ file: CAPABILITY_PROOF_FILE, sha256: null, status: "MISSING" });
  expect(result.verifier_sha256).toBe(digest(JSON.stringify(result.verifier)));
});

test("v3 unknown, duplicate and mismatched gate references fail the index without consuming families", () => {
  const f = fixture(), missing = join(f.root, "absent-receipt.json");
  asV3(f, [receiptRef("kizuki.unknown/v1", SURFACE_GATE, null, missing)]);
  const unknown = evaluateRelease("rc", f.indexPath);
  expect(gate(unknown, "evidence.index")).toMatchObject({ status: "FAIL", reason: "unknown-producer" });
  expect(gate(unknown, `artifact.${target}`).status).toBe("PASS");
  expect(gate(unknown, SURFACE_GATE).status).toBe("NOT_IMPLEMENTED");
  asV3(f, [receiptRef(SURFACE_PRODUCER, SURFACE_GATE, null, missing), receiptRef(SURFACE_PRODUCER, SURFACE_GATE, null, join(f.root, "other.json"))]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("duplicate-gate");
  asV3(f, [receiptRef(SURFACE_PRODUCER, SURFACE_GATE, target, missing)]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("mismatched-gate-or-target");
  asV3(f, [receiptRef("kizuki.native-attestation/v1", `native.${target}`, null, missing)]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("mismatched-gate-or-target");
  asV3(f, [receiptRef("kizuki.journey-proof/v1", "journey.not-a-journey", null, missing)]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("mismatched-gate-or-target");
  asV3(f, [receiptRef("kizuki.connector-evidence/v1", "connector.beeper", null, missing)]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("mismatched-gate-or-target");
  asV3(f, [receiptRef("kizuki.native-attestation/v1", `native.${target}`, "bun-darwin-arm64", missing)]);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").reason).toBe("mismatched-gate-or-target");
});

test("inactive producers keep default states even when v3 lists missing receipts", () => {
  const f = fixture(), missing = join(f.root, "never-opened.json");
  const receipts = [
    ...TARGETS.flatMap(platform => [
      receiptRef("kizuki.native-attestation/v1", `native.${platform}`, platform, missing),
      receiptRef("kizuki.native-lifecycle/v1", `lifecycle.${platform}`, platform, missing),
    ]),
    receiptRef("kizuki.required-checks/v1", "candidate.required-checks", null, missing),
    receiptRef("kizuki.independent-review/v1", "candidate.independent-review", null, missing),
    receiptRef("kizuki.p0-disposition/v1", "candidate.current-p0-disposition", null, missing),
    receiptRef(SURFACE_PRODUCER, SURFACE_GATE, null, missing),
    ...JOURNEYS.map(id => receiptRef("kizuki.journey-proof/v1", `journey.${id}`, null, missing)),
    ...CONNECTORS.map(item => receiptRef("kizuki.connector-evidence/v1", `connector.${item.id}`, null, missing)),
    receiptRef("kizuki.unfamiliar-user/v1", "human.unfamiliar-user", null, missing),
    receiptRef("kizuki.owner-rails-observation/v1", "owner.seven-day-rails", null, missing),
    receiptRef("kizuki.estate-parity-observation/v1", "estate.fourteen-day-parity", null, missing),
    receiptRef("kizuki.cutover-authority/v1", "owner.final-cutover", null, missing),
  ];
  asV3(f, receipts);
  const result = evaluateRelease("1.0", f.indexPath);
  expect(gate(result, "evidence.index").status).toBe("PASS");
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  for (const platform of TARGETS) {
    expect(gate(result, `native.${platform}`)).toMatchObject({ status: "UNVERIFIABLE", evidence_sha256: null });
    expect(gate(result, `lifecycle.${platform}`)).toMatchObject({ status: "NOT_IMPLEMENTED", evidence_sha256: null });
  }
  expect(gate(result, "candidate.required-checks").status).toBe("NOT_IMPLEMENTED");
  expect(gate(result, "candidate.independent-review").status).toBe("NOT_IMPLEMENTED");
  expect(gate(result, "candidate.current-p0-disposition").status).toBe("UNVERIFIABLE");
  expect(gate(result, SURFACE_GATE)).toMatchObject({ status: "NOT_IMPLEMENTED", evidence_sha256: null });
  for (const id of JOURNEYS) expect(gate(result, `journey.${id}`).status).toBe("NOT_IMPLEMENTED");
  for (const item of CONNECTORS) expect(gate(result, `connector.${item.id}`).status).toBe("NOT_IMPLEMENTED");
  expect(gate(result, "human.unfamiliar-user").status).toBe("NOT_IMPLEMENTED");
  expect(result.decision).toBe("NO-GO");
  expect(result.release_1_0_accepted).toBe(false);
});

test("v3 index byte cap is 32 KiB while v1 stays at 16 KiB", () => {
  const f = asV3(fixture());
  const raw = `${readFileSync(f.indexPath, "utf8")}${" ".repeat(20000)}`;
  writeFileSync(f.indexPath, raw);
  expect(raw.length).toBeGreaterThan(EVIDENCE_LIMITS.index);
  expect(raw.length).toBeLessThanOrEqual(EVIDENCE_LIMITS.index_v3);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("PASS");
  writeFileSync(f.indexPath, `${raw}${" ".repeat(EVIDENCE_LIMITS.index_v3)}`);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
});

test("optional capability verifier is MISSING until a regular file exists and other errors are fatal", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-verifier-")); roots.push(root);
  mkdirSync(join(root, "scripts"));
  expect(inspectOptionalVerifier(root, CAPABILITY_PROOF_FILE)).toEqual({ file: CAPABILITY_PROOF_FILE, sha256: null, status: "MISSING" });
  writeFileSync(join(root, CAPABILITY_PROOF_FILE), "export {}\n");
  expect(inspectOptionalVerifier(root, CAPABILITY_PROOF_FILE)).toEqual({
    file: CAPABILITY_PROOF_FILE, sha256: digest("export {}\n"), status: "PRESENT",
  });
  rmSync(join(root, CAPABILITY_PROOF_FILE));
  mkdirSync(join(root, CAPABILITY_PROOF_FILE));
  expect(() => inspectOptionalVerifier(root, CAPABILITY_PROOF_FILE)).toThrow(EvidenceError);
  rmSync(join(root, CAPABILITY_PROOF_FILE), { recursive: true });
  symlinkSync(join(root, "scripts"), join(root, "link.ts"));
  expect(() => inspectOptionalVerifier(root, "link.ts")).toThrow(EvidenceError);
});

test("surface validator recomputes inventories and refuses a self-declared empty disagreement list", () => {
  const tree = surfaceCandidate();
  expect(cliVerbSequence()).toEqual([
    "app", "init", "import", "doctor", "query", "context", "connect", "backfill", "sync",
    "tell", "undo", "audit", "serve", "models", "agent", "purge", "export", "restore", "version", "rebuild",
  ]);
  expect(tree.expected.cli_verbs).toEqual(cliVerbSequence());
  expect(tree.expected.retired_verbs).toEqual(["review", "promote", "reject"]);
  expect(tree.expected.connectors_c3).toEqual(CONNECTORS.map(item => ({ id: item.id, connector_id: item.connector_id, evidence: item.evidence })));
  expect(tree.expected.docs.files.map(item => item.path)).toEqual([...SURFACE_DOC_FILES]);
  expect(tree.expected.producer_revision).toBe(producerRevision(tree.root, SURFACE_PRODUCER_FILES));
  expect(evaluateSurfaceReceipt(surfaceBody(tree.expected), tree.root, tree.sha)).toMatchObject({ status: "PASS", reason: "surface-inventory-agrees", creditDigest: true });
  const mismatched = surfaceBody(tree.expected, { bun_version: "0.0.0", disagreements: [] });
  expect(() => evaluateSurfaceReceipt(mismatched, tree.root, tree.sha)).toThrow("surface-disagreement-mismatch");
  const truthful = surfaceBody(tree.expected, {
    bun_version: "0.0.0", outcome: "fail", failures: [{ code: "bun-version-mismatch" }],
    disagreements: [{ code: "bun-version-mismatch", path: "bun_version" }],
  });
  expect(evaluateSurfaceReceipt(truthful, tree.root, tree.sha)).toMatchObject({ status: "FAIL", reason: "surface-outcome-fail", creditDigest: true });
  expect(() => evaluateSurfaceReceipt(surfaceBody(tree.expected, {
    bun_version: "0.0.0", disagreements: [{ code: "bun-version-mismatch", path: "bun_version" }],
  }), tree.root, tree.sha)).toThrow("invalid-outcome");
  const unresolved = surfaceBody(tree.expected, { outcome: "unresolved" });
  expect(evaluateSurfaceReceipt(unresolved, tree.root, tree.sha)).toMatchObject({ status: "UNVERIFIABLE", reason: "surface-outcome-unresolved", creditDigest: true });
});

test("surface identity, revision, RFC3339 and custody failures do not credit a digest", () => {
  const tree = surfaceCandidate();
  const fail = (patch: Record<string, unknown>, reason: string) => {
    try { evaluateSurfaceReceipt(surfaceBody(tree.expected, patch), tree.root, tree.sha); throw new Error("expected throw"); }
    catch (error) { expect(error).toBeInstanceOf(EvidenceError); expect((error as EvidenceError).reason).toBe(reason); }
  };
  fail({ identity: { ...surfaceBody(tree.expected).identity, candidate_source_sha: "b".repeat(40) } }, "candidate-mismatch");
  fail({ identity: { ...surfaceBody(tree.expected).identity, producer_revision: "c".repeat(64) } }, "producer-revision-mismatch");
  fail({ identity: { ...surfaceBody(tree.expected).identity, producer_files: ["scripts/release-evidence.ts"] } }, "producer-files-mismatch");
  fail({ identity: { ...surfaceBody(tree.expected).identity, source_class: "synthetic-fixture" } }, "invalid-identity");
  fail({ identity: { ...surfaceBody(tree.expected).identity, recorded_at: "2026-02-30T00:00:00.000Z" } }, "invalid-recorded-at");
  fail({ identity: { ...surfaceBody(tree.expected).identity, recorded_at: "2026-09-06T00:00:00Z" } }, "invalid-recorded-at");
  fail({ identity: { ...surfaceBody(tree.expected).identity, attempt_id: "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee" } }, "invalid-identity");
  const receiptPath = join(tree.root, "surface.json");
  writeFileSync(receiptPath, JSON.stringify(surfaceBody(tree.expected)));
  expect(read(receiptPath, EVIDENCE_LIMITS.family_receipt).sha256).toBe(digest(readFileSync(receiptPath)));
  truncateSync(receiptPath, EVIDENCE_LIMITS.family_receipt + 1);
  expect(() => read(receiptPath, EVIDENCE_LIMITS.family_receipt)).toThrow("unsafe-file-or-size");
});

test("v3 refuses extra keys and more than forty gate receipts", () => {
  const f = fixture();
  writeFileSync(f.indexPath, `{"owner_authorized":true,${JSON.stringify({ ...f.index, schema: "kizuki.acceptance-evidence/v3", gate_receipts: [] }).slice(1)}`);
  expect(gate(evaluateRelease("rc", f.indexPath), "evidence.index").status).toBe("FAIL");
  asV3(f, Array.from({ length: 41 }, (_, i) => receiptRef("kizuki.required-checks/v1", "candidate.required-checks", null, join(f.root, `r${i}.json`))));
  const overflow = evaluateRelease("rc", f.indexPath);
  expect(gate(overflow, "evidence.index").status).toBe("FAIL");
  expect(gate(overflow, `artifact.${target}`).status).toBe("MISSING");
});

