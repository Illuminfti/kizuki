import { expect, test } from "bun:test";
import { ARTIFACT_PACKAGE_FILES, ArtifactProofError, PROOF_JSON_LIMITS, SQLITE_ENGINE_POLICY,
  artifactProofSteps, parseProofJson, validateArtifactProof } from "./artifact-proof";
import type { ArtifactPackageFile, ArtifactProofSchema } from "./artifact-proof";

function fixture(schema: ArtifactProofSchema = "kizuki.artifact-proof/v2") {
  const package_sha256 = Object.fromEntries(ARTIFACT_PACKAGE_FILES.map((name, index) => [name, String(index + 1).repeat(64)])) as Record<ArtifactPackageFile, string>;
  const expected = { source_sha: "a".repeat(40), target: "bun-linux-x64-baseline", bun_version: "1.3.14", package_sha256 };
  const execution = "/tmp/kizuki-artifact-proof-contract/execution";
  const paths = { executable: "/tmp/kizuki-artifact-proof-contract/artifact/kizuki", home: `${execution}/home`, config: `${execution}/config/kizuki.toml`, vault: `${execution}/vault`, restored_vault: `${execution}/restored` };
  const runtime = { schema: "kizuki.sqlite-runtime/v1", bun_version: expected.bun_version,
    sqlite_version: "3.53.0", sqlite_source_id: "2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b" };
  const proof = {
    schema, ...expected, host_platform: "linux", host_arch: "x64", binary_sha256: package_sha256.kizuki,
    paths, steps: artifactProofSteps(schema, paths).map(step => ({ ...step, exit_code: 0, passed: true })), failures: [] as string[],
    ...(schema === "kizuki.artifact-proof/v2" ? { host_kernel_release: "synthetic-kernel", engine_observations: {
      kizuki: { executable_sha256: package_sha256.kizuki, runtime: { ...runtime }, exit_code: 0, doctor_status: "ok" },
      kizuki_mcp: { executable_sha256: package_sha256["kizuki-mcp"], runtime: { ...runtime }, exit_code: 0, mcp_is_error: false },
    } } : {}),
  };
  return { proof, expected };
}

test("strict JSON keeps independent object keys and handles quoted structure", () => {
  const value = { objects: [{ key: 1 }, { key: 2 }], text: 'quoted "key": [value] and \\ slash' };
  expect(parseProofJson(JSON.stringify(value))).toEqual(value);
  expect(parseProofJson(new TextEncoder().encode(JSON.stringify(value)))).toEqual(value);
});

test.each([
  '{"key":1,"key":2}', '{"key":1,"\\u006bey":2}',
  '{"outer":[{"key":1,"key":2}]}',
])("strict JSON refuses duplicate keys %# without repeating input", (raw) => {
  expect(() => parseProofJson(raw)).toThrow(new ArtifactProofError("duplicate-json-key"));
});

test("strict JSON enforces its byte and nesting boundaries", () => {
  const nested = "[".repeat(PROOF_JSON_LIMITS.depth) + "0" + "]".repeat(PROOF_JSON_LIMITS.depth);
  expect(() => parseProofJson(nested)).not.toThrow();
  expect(() => parseProofJson(`[${nested}]`)).toThrow(new ArtifactProofError("json-depth-limit"));
  const boundary = '"' + "x".repeat(PROOF_JSON_LIMITS.bytes - 2) + '"';
  expect((parseProofJson(boundary) as string).length).toBe(PROOF_JSON_LIMITS.bytes - 2);
  expect(() => parseProofJson(boundary + " ")).toThrow(new ArtifactProofError("json-byte-limit"));
  expect(() => parseProofJson(new Uint8Array(PROOF_JSON_LIMITS.bytes + 1))).toThrow(new ArtifactProofError("json-byte-limit"));
});

test.each(['{"synthetic":', '{} {}', '\uFEFF{}'])("invalid JSON %# has a fixed error", raw => {
  expect(() => parseProofJson(raw)).toThrow(new ArtifactProofError("invalid-json"));
});
test("invalid UTF-8 is refused before parsing", () => {
  expect(() => parseProofJson(new Uint8Array([0xff]))).toThrow(new ArtifactProofError("invalid-json"));
});

test("v1 retains the exact fourteen-step order; v2 inserts only two engine steps", () => {
  const { proof } = fixture("kizuki.artifact-proof/v1"), { vault, restored_vault: restored } = proof.paths;
  const execution = "/tmp/kizuki-artifact-proof-contract/execution", exported = `${execution}/export`;
  const commands = [
    ["kizuki", "--help"], ["kizuki", "init", vault, "--no-service"],
    ["kizuki", "import", "markdown-folder", "--source", `${execution}/notes`, "--policy", `${execution}/source-policy.json`, "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", vault],
    ["kizuki", "query", "Ada", "--vault", vault], ["assert", "fixture is recalled"],
    ["kizuki", "context", "--query", "Ada", "--vault", vault], ["assert", "fixture is recalled"],
    ["kizuki", "export", "--out", exported, "--vault", vault], ["kizuki", "restore", "--from", exported, "--verify"],
    ["kizuki", "restore", "--from", exported, "--into", restored],
    ["kizuki", "query", "Ada", "--degraded", "--vault", restored], ["assert", "fixture is recalled"],
    ["kizuki", "context", "--query", "Ada", "--vault", restored], ["assert", "fixture is recalled"],
  ];
  expect(proof.steps.map(step => step.id)).toEqual(["help", "init", "import", "query", "query-result", "context", "context-result", "export", "restore-verify", "restore", "restored-query", "restored-query-result", "restored-context", "restored-context-result"]);
  expect(proof.steps.map(step => step.command)).toEqual(commands);
  const v2 = artifactProofSteps("kizuki.artifact-proof/v2", proof.paths);
  expect(v2.slice(2, 4)).toEqual([
    { id: "cli-engine", command: ["kizuki", "doctor", "--json", "--vault", vault], timeout_ms: 30_000 },
    { id: "mcp-engine", command: ["kizuki-mcp", "--vault", vault, "--owner"], timeout_ms: 30_000 },
  ]);
  expect([...v2.slice(0, 2), ...v2.slice(4)]).toEqual(artifactProofSteps("kizuki.artifact-proof/v1", proof.paths));
});

test("historical v1 is readable with no engine credit", () => {
  const { proof, expected } = fixture("kizuki.artifact-proof/v1");
  proof.bun_version = expected.bun_version = "1.3.10";
  expect(validateArtifactProof(proof, expected)).toEqual({ schema: proof.schema, engine: { status: "MISSING", reason: "missing-engine-proof" } });
});

test.each([0, 1])("v2 qualifies both exact engines while preserving doctor exit %d", exit => {
  const { proof, expected } = fixture();
  proof.engine_observations!.kizuki.exit_code = proof.steps[2]!.exit_code = exit;
  proof.engine_observations!.kizuki.doctor_status = exit === 0 ? "ok" : "error";
  expect(validateArtifactProof(proof, expected)).toEqual({ schema: proof.schema, engine: { status: "PASS", reason: "effective-sqlite-identity-qualified" } });
});

test("the initial engine policy names the official exact pair", () => {
  const { proof } = fixture();
  expect(SQLITE_ENGINE_POLICY.accepted).toHaveLength(1);
  const entry = SQLITE_ENGINE_POLICY.accepted[0];
  expect(proof.engine_observations!.kizuki.runtime.sqlite_version).toBe(entry.sqlite_version);
  expect(proof.engine_observations!.kizuki.runtime.sqlite_source_id).toBe(entry.sqlite_source_id);
  expect(entry.source_url).toBe("https://www.sqlite.org/releaselog/3_53_0.html");
});

test.each(["version", "source-id"])("matching unknown engine %s stays observable and unqualified", field => {
  const { proof, expected } = fixture();
  for (const observation of Object.values(proof.engine_observations!)) {
    if (field === "version") observation.runtime.sqlite_version = "3.53.1";
    else observation.runtime.sqlite_source_id = "synthetic unknown source identity";
  }
  expect(validateArtifactProof(proof, expected).engine).toEqual({ status: "FAIL", reason: "unqualified-sqlite-identity" });
});

for (const [label, mutate] of [
  ["unknown receipt field", (p) => Object.assign(p, { extra: true })],
  ["unknown runtime field", (p) => Object.assign(p.engine_observations!.kizuki.runtime, { extra: true })],
  ["missing observation", (p) => Object.assign(p.engine_observations!, { kizuki_mcp: null })],
  ["different executable", (p) => { p.engine_observations!.kizuki_mcp.executable_sha256 = p.binary_sha256; }],
  ["different Bun", (p) => { p.engine_observations!.kizuki_mcp.runtime.bun_version = "9.9.9"; }],
  ["different SQLite", (p) => { p.engine_observations!.kizuki_mcp.runtime.sqlite_version = "3.53.1"; }],
  ["different source identity", (p) => { p.engine_observations!.kizuki_mcp.runtime.sqlite_source_id = "synthetic other source"; }],
  ["contradictory doctor result", (p) => { p.engine_observations!.kizuki.doctor_status = "error"; }],
  ["MCP error result", (p) => { p.engine_observations!.kizuki_mcp.mcp_is_error = true; }],
  ["unrecorded doctor exit", (p) => { p.steps[2]!.exit_code = 1; }],
  ["nonengine failure exit", (p) => { p.steps[4]!.exit_code = 1; }],
  ["missing step", (p) => { p.steps.splice(4, 1); }],
  ["reordered steps", (p) => { [p.steps[2], p.steps[3]] = [p.steps[3]!, p.steps[2]!]; }],
  ["substituted command", (p) => { p.steps[2]!.command = ["kizuki", "--help"]; }],
  ["wrong timeout", (p) => { p.steps[2]!.timeout_ms = 0; }],
  ["wrong host", (p) => { p.host_platform = "darwin"; }],
  ["inconsistent paths", (p) => { p.paths.home = p.paths.vault; }],
  ["empty kernel release", (p) => { p.host_kernel_release = ""; }],
  ["failed receipt", (p) => { p.failures.push("synthetic failure"); }],
] satisfies [string, (proof: ReturnType<typeof fixture>["proof"]) => unknown][]) {
  test(`v2 refuses ${label}`, () => {
    const { proof, expected } = fixture(); mutate(proof);
    expect(() => validateArtifactProof(proof, expected)).toThrow(ArtifactProofError);
  });
}
