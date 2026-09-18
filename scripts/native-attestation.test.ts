import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRelease } from "./go-no-go";
import { parseNativeAttestationArgs, runNativeAttestation } from "./native-attestation";
import {
  EVALUATOR_ROOT, EvidenceError, NATIVE_ATTESTATION_PRODUCER, NATIVE_ATTESTATION_PRODUCER_FILES,
  evaluateNativeAttestationReceipt, producerRevision,
} from "./release-evidence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const linux = "bun-linux-x64-baseline";

function executablePackage(target = linux) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-native-attestation-")); roots.push(root);
  const artifact = join(root, "artifact"); mkdirSync(artifact);
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(artifact, "kizuki"), "#!/bin/sh\necho native-attestation-fixture\nexit 0\n", { mode: 0o755 });
  chmodSync(join(artifact, "kizuki"), 0o755);
  writeFileSync(join(artifact, "kizuki-mcp"), "#!/bin/sh\necho native-attestation-mcp-fixture >&2\nexit 0\n", { mode: 0o755 });
  chmodSync(join(artifact, "kizuki-mcp"), 0o755);
  writeFileSync(join(artifact, "README.txt"), "Synthetic README.txt evaluator fixture.");
  writeFileSync(join(artifact, "BUILD.json"), JSON.stringify({ schema: "kizuki.release-build/v1", source_sha: source, target, bun_version: "1.3.14" }));
  writeFileSync(join(artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(artifact, name)))}  ${name}`).join("\n") + "\n");
  const proof = join(root, "proof.json");
  const receipt = {
    schema: "kizuki.artifact-proof/v1", source_sha: source, target,
    host_platform: target === linux ? "linux" : "darwin", host_arch: target === linux ? "x64" : "arm64",
    binary_sha256: digest(readFileSync(join(artifact, "kizuki"))), bun_version: "1.3.14",
    package_sha256: Object.fromEntries([...names, "SHA256SUMS"].map(name => [name, digest(readFileSync(join(artifact, name)))])),
    paths: {
      executable: "/tmp/kizuki-artifact-proof-synthetic/artifact/kizuki",
      home: "/tmp/kizuki-artifact-proof-synthetic/execution/home",
      config: "/tmp/kizuki-artifact-proof-synthetic/execution/config/kizuki.toml",
      vault: "/tmp/kizuki-artifact-proof-synthetic/execution/vault",
      restored_vault: "/tmp/kizuki-artifact-proof-synthetic/execution/restored",
    },
    steps: [
      ["help", ["--help"]], ["init", ["init", "/tmp/kizuki-artifact-proof-synthetic/execution/vault", "--no-service"]],
      ["import", ["import", "markdown-folder", "--source", "/tmp/kizuki-artifact-proof-synthetic/execution/notes", "--policy", "/tmp/kizuki-artifact-proof-synthetic/execution/source-policy.json", "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/vault"]],
      ["query", ["query", "Ada", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/vault"]], ["query-result", []],
      ["context", ["context", "--query", "Ada", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/vault"]], ["context-result", []],
      ["export", ["export", "--out", "/tmp/kizuki-artifact-proof-synthetic/execution/export", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/vault"]],
      ["restore-verify", ["restore", "--from", "/tmp/kizuki-artifact-proof-synthetic/execution/export", "--verify"]],
      ["restore", ["restore", "--from", "/tmp/kizuki-artifact-proof-synthetic/execution/export", "--into", "/tmp/kizuki-artifact-proof-synthetic/execution/restored"]],
      ["restored-query", ["query", "Ada", "--degraded", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/restored"]], ["restored-query-result", []],
      ["restored-context", ["context", "--query", "Ada", "--vault", "/tmp/kizuki-artifact-proof-synthetic/execution/restored"]], ["restored-context-result", []],
    ].map(([id, args]) => ({ id, command: (args as string[]).length ? ["kizuki", ...args as string[]] : ["assert", "fixture is recalled"], exit_code: 0, passed: true, timeout_ms: (args as string[]).length ? 30000 : 0 })),
    failures: [] as string[],
  };
  writeFileSync(proof, JSON.stringify(receipt));
  const ref = { producer: "kizuki.artifact-proof/v1", target, directory: artifact, proof, proof_sha256: digest(readFileSync(proof)) };
  const indexPath = join(root, "index.json");
  return { root, artifact, proof, ref, indexPath, receipt };
}

function expectedBinding(package_sha256: Record<string, string>, target = linux) {
  const files = NATIVE_ATTESTATION_PRODUCER_FILES.map(path => ({ path, sha256: digest(readFileSync(join(EVALUATOR_ROOT, path))) }));
  return {
    candidate_source_sha: source, target, producer_files: [...NATIVE_ATTESTATION_PRODUCER_FILES],
    producer_revision: producerRevision(files), package_sha256,
    evaluator_platform: process.platform, evaluator_arch: process.arch,
    bun_version: readFileSync(join(EVALUATOR_ROOT, ".bun-version"), "utf8").trim(),
  };
}

function gate(result: ReturnType<typeof evaluateRelease>, id: string) {
  return result.gates.find(row => row.id === id)!;
}

test("producer executes the package binary and the evaluator accepts that exact target", () => {
  const f = executablePackage();
  const out = join(f.root, "native.json");
  const produced = runNativeAttestation({ candidate: source, artifact: f.artifact, out });
  expect(produced).toMatchObject({ producer: NATIVE_ATTESTATION_PRODUCER, gate_id: `native.${linux}`, target: linux, path: out });
  const body = JSON.parse(readFileSync(out, "utf8"));
  expect(body.mcp_argv).toEqual(["kizuki-mcp"]);
  expect(body.mcp_exit_code).toBe(0);
  expect(body.mcp_stderr_sha256).toBe(digest("native-attestation-mcp-fixture\n"));
  expect(evaluateNativeAttestationReceipt(body, expectedBinding(body.package_sha256))).toMatchObject({
    status: "PASS", reason: "native-host-execution-attested", creditDigest: true,
  });
  writeFileSync(f.indexPath, JSON.stringify({
    schema: "kizuki.acceptance-evidence/v3", candidate_source_sha: source, artifacts: [f.ref], fixture_observation: null,
    gate_receipts: [produced],
  }));
  const result = evaluateRelease("rc", f.indexPath);
  expect(gate(result, `native.${linux}`)).toMatchObject({ status: "PASS", reason: "native-host-execution-attested", evidence_sha256: produced.sha256 });
  expect(gate(result, "native.bun-darwin-arm64")).toMatchObject({ status: "UNVERIFIABLE", evidence_sha256: null });
  expect(result.decision).toBe("NO-GO");
});

test.each(["simulated", "host-label", "cross-compiled"] as const)("%s execution cannot certify native execution", (execution_class) => {
  const f = executablePackage();
  const out = join(f.root, "native.json");
  runNativeAttestation({ candidate: source, artifact: f.artifact, out });
  const body = JSON.parse(readFileSync(out, "utf8"));
  body.execution_class = execution_class;
  expect(evaluateNativeAttestationReceipt(body, expectedBinding(body.package_sha256))).toMatchObject({
    status: "FAIL", reason: "cannot-certify-native-execution",
  });
  writeFileSync(out, JSON.stringify(body));
  writeFileSync(f.indexPath, JSON.stringify({
    schema: "kizuki.acceptance-evidence/v3", candidate_source_sha: source, artifacts: [f.ref], fixture_observation: null,
    gate_receipts: [{ producer: NATIVE_ATTESTATION_PRODUCER, gate_id: `native.${linux}`, target: linux, path: out, sha256: digest(readFileSync(out)) }],
  }));
  expect(gate(evaluateRelease("rc", f.indexPath), `native.${linux}`)).toMatchObject({ status: "FAIL", reason: "cannot-certify-native-execution" });
});

test.each([
  ["altered SHA", (body: Record<string, any>) => { body.identity.candidate_source_sha = "b".repeat(40); }, "candidate-mismatch"],
  ["wrong target", (body: Record<string, any>) => { body.target = "bun-darwin-arm64"; body.host_platform = "darwin"; body.host_arch = "arm64"; }, "mismatched-gate-or-target"],
  ["stale producer revision", (body: Record<string, any>) => { body.identity.producer_revision = "c".repeat(64); }, "producer-revision-mismatch"],
  ["mutated stdout digest", (body: Record<string, any>) => { body.binary_sha256 = "d".repeat(64); }, "proof-identity-mismatch"],
  ["substituted MCP command", (body: Record<string, any>) => { body.mcp_argv = ["kizuki"]; }, "native-command-substituted"],
] as const)("%s fails closed", (_label, mutate, reason) => {
  const f = executablePackage();
  const out = join(f.root, "native.json");
  runNativeAttestation({ candidate: source, artifact: f.artifact, out });
  const body = JSON.parse(readFileSync(out, "utf8"));
  mutate(body);
  expect(() => evaluateNativeAttestationReceipt(body, expectedBinding(body.package_sha256, linux))).toThrow(reason);
});

test("a darwin host label on this evaluator cannot become a native PASS", () => {
  const f = executablePackage();
  const out = join(f.root, "native.json");
  runNativeAttestation({ candidate: source, artifact: f.artifact, out });
  const body = JSON.parse(readFileSync(out, "utf8"));
  const mac = executablePackage("bun-darwin-arm64");
  expect(evaluateNativeAttestationReceipt({
    ...body, target: "bun-darwin-arm64", host_platform: "darwin", host_arch: "arm64", package_sha256: mac.receipt.package_sha256, binary_sha256: mac.receipt.package_sha256.kizuki,
  }, expectedBinding(mac.receipt.package_sha256, "bun-darwin-arm64"))).toMatchObject({
    status: "UNVERIFIABLE", reason: "evaluator-cannot-certify-native-target", creditDigest: false,
  });
});

test("producer refuses a non-native target instead of simulating the host", () => {
  if (process.platform === "darwin" && process.arch === "arm64") return;
  const f = executablePackage("bun-darwin-arm64");
  expect(() => runNativeAttestation({ candidate: source, artifact: f.artifact, out: join(f.root, "native.json") })).toThrow("cannot-certify-native-execution");
});

test("producer refuses a non-runnable MCP binary instead of attesting CLI-only execution", () => {
  const f = executablePackage();
  writeFileSync(join(f.artifact, "kizuki-mcp"), "Synthetic kizuki-mcp. Never executed.");
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(f.artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(f.artifact, name)))}  ${name}`).join("\n") + "\n");
  expect(() => runNativeAttestation({ candidate: source, artifact: f.artifact, out: join(f.root, "native.json") })).toThrow("native-mcp-execution-failed");
});

test.each(["kizuki", "kizuki-mcp"])("producer cannot credit %s exiting successfully from its timeout handler", binary => {
  const f = executablePackage();
  writeFileSync(join(f.artifact, binary), "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do :; done\n");
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(f.artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(f.artifact, name)))}  ${name}`).join("\n") + "\n");
  const out = join(f.root, "native.json");
  expect(() => runNativeAttestation({ candidate: source, artifact: f.artifact, out }))
    .toThrow(binary === "kizuki" ? "native-execution-failed" : "native-mcp-execution-failed");
  expect(() => readFileSync(out)).toThrow();
}, 15_000);

test.each([
  ["kizuki", "stdout"], ["kizuki", "stderr"],
  ["kizuki-mcp", "stdout"], ["kizuki-mcp", "stderr"],
] as const)("producer refuses oversized %s %s without publishing a receipt", (binary, stream) => {
  const f = executablePackage();
  writeFileSync(join(f.artifact, binary), `#!/bin/sh\nprintf '%1048577s' x ${stream === "stderr" ? ">&2" : ""}\nexit 0\n`);
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(f.artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(f.artifact, name)))}  ${name}`).join("\n") + "\n");
  const out = join(f.root, "native.json");
  expect(() => runNativeAttestation({ candidate: source, artifact: f.artifact, out }))
    .toThrow(binary === "kizuki" ? "native-execution-failed" : "native-mcp-execution-failed");
  expect(() => readFileSync(out)).toThrow();
});

test.each(["kizuki", "kizuki-mcp"])("producer accepts %s output at the byte bound", binary => {
  const f = executablePackage();
  writeFileSync(join(f.artifact, binary), "#!/bin/sh\nprintf '%1048576s' x\nexit 0\n");
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  writeFileSync(join(f.artifact, "SHA256SUMS"), names.map(name => `${digest(readFileSync(join(f.artifact, name)))}  ${name}`).join("\n") + "\n");
  const out = join(f.root, "native.json");
  expect(runNativeAttestation({ candidate: source, artifact: f.artifact, out }).path).toBe(out);
});

test("wrong candidate argument is refused before execution credit", () => {
  const f = executablePackage();
  expect(() => runNativeAttestation({ candidate: "b".repeat(40), artifact: f.artifact, out: join(f.root, "native.json") })).toThrow("candidate-mismatch");
});

test("parseNativeAttestationArgs is exact and absolute", () => {
  expect(() => parseNativeAttestationArgs(["--candidate", source])).toThrow("invalid-arguments");
  const parsed = parseNativeAttestationArgs(["--candidate", source, "--artifact", "/tmp/native-artifact", "--out", "/tmp/native.json"]);
  expect(parsed).toEqual({ candidate: source, artifact: "/tmp/native-artifact", out: "/tmp/native.json" });
});

test("EvidenceError remains the public failure type", () => {
  try { parseNativeAttestationArgs([]); throw new Error("expected throw"); }
  catch (error) { expect(error).toBeInstanceOf(EvidenceError); }
});
