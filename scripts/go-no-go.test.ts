import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRelease, parseAcceptanceArgs, writeAcceptanceReport } from "./go-no-go";
import { initQualification } from "./qualification";
import { initVault } from "../packages/core/src/vault/init";
import { openLedger } from "../packages/core/src/ledger/db";
import { initServe } from "../packages/core/src/serve/schema";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const target = "bun-linux-x64-baseline";
function fixture(platform = target) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-acceptance-fixture-")); roots.push(root);
  const artifact = join(root, "artifact"); mkdirSync(artifact);
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  for (const name of names.slice(0, 3)) writeFileSync(join(artifact, name), "Synthetic evaluator fixture. Never executed.");
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

test("all fixed journeys, C3 connectors and separate 1.0 gates remain visible without evidence", () => {
  const f = fixture(); f.index.artifacts = []; f.save();
  for (const profile of ["rc", "1.0"] as const) {
    const result = evaluateRelease(profile, f.indexPath);
    expect(result.decision).toBe("NO-GO"); expect(result.release_1_0_accepted).toBe(false);
    expect(result.gates.filter(row => row.id.startsWith("journey.")).map(row => row.id)).toEqual([
      "journey.connect-resume", "journey.correct-belief", "journey.revoke-purge", "journey.retrieve-trustworthily", "journey.import-estate-slice", "journey.daily-loop", "journey.useful-insight", "journey.install-recover",
    ]);
    expect(result.connectors).toHaveLength(15);
    expect(gate(result, `artifact.${target}`).status).toBe("MISSING");
    expect(gate(result, "owner.seven-day-rails").required).toBe(profile === "1.0");
    expect(gate(result, "estate.fourteen-day-parity").status).toBe("NOT_IMPLEMENTED");
  }
});

test("consistent fixture bytes receive only local integrity credit, never native, human or release approval", () => {
  const f = fixture(), mac = fixture("bun-darwin-arm64"); f.index.artifacts.push(mac.ref); f.save();
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `artifact.${target}`).status).toBe("PASS");
  expect(gate(result, "artifact.bun-darwin-arm64").status).toBe("PASS");
  expect(gate(result, `artifact.${target}`).scope).toBe("automated-fixture-integrity");
  expect(gate(result, `native.${target}`).status).toBe("UNVERIFIABLE");
  expect(gate(result, "human.unfamiliar-user").status).toBe("NOT_IMPLEMENTED");
  expect(result.decision).toBe("NO-GO");
  expect(result.evidence[0]!.producer_revision).toBeNull();
  expect(result.policy_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.verifier_sha256).toMatch(/^[a-f0-9]{64}$/);
  const output = JSON.stringify(result);
  expect(output).not.toContain(f.root); expect(output).not.toContain(f.receipt.paths.vault);
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
