import { afterEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCapabilityArgs } from "./capability-proof";
import { CAPABILITY_PROOF_FILE, EVALUATOR_ROOT, SURFACE_DOC_FILES, SURFACE_GATE, SURFACE_PRODUCER, hash } from "./release-evidence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function command(args: string[], cwd: string) {
  return Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
}
function git(root: string, args: string[]) {
  const child = command(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Surface Fixture", "-c", "user.email=surface@example.invalid", "-C", root, ...args], root);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return child.stdout.toString().trim();
}
/** Copy actual tracked source into an independent Git candidate. Retain local
 * workspace links and the already installed third-party dependency boundary. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-surface-proof-")); roots.push(root);
  const repo = join(root, "candidate"); mkdirSync(repo);
  const files = git(EVALUATOR_ROOT, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of files) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    cpSync(join(EVALUATOR_ROOT, path), join(repo, path), { verbatimSymlinks: true });
  }
  symlinkSync(join(EVALUATOR_ROOT, "node_modules"), join(repo, "node_modules"), "dir");
  for (const name of readdirSync(join(repo, "packages"))) {
    const dependencies = join(EVALUATOR_ROOT, "packages", name, "node_modules");
    if (existsSync(dependencies)) cpSync(dependencies, join(repo, "packages", name, "node_modules"), { recursive: true, verbatimSymlinks: true });
  }
  git(repo, ["init", "--quiet"]); git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Bind actual surface fixture source"]);
  const candidate = git(repo, ["rev-parse", "HEAD"]), out = join(root, "surface.json"), index = join(root, "index.json");
  const emit = (flags = ["--candidate", candidate, "--out", out]) => command([process.execPath, join(repo, CAPABILITY_PROOF_FILE), ...flags], repo);
  const evaluate = (reference: unknown, candidateSha = candidate, evaluatorRoot = repo, candidateRoot?: string) => {
    writeFileSync(index, JSON.stringify({ schema: "kizuki.acceptance-evidence/v3", candidate_source_sha: candidateSha,
      artifacts: [], fixture_observation: null, gate_receipts: [reference] }));
    const child = command([process.execPath, "--eval", `import { evaluateRelease } from ${JSON.stringify(join(evaluatorRoot, "scripts/go-no-go.ts"))}; process.stdout.write(JSON.stringify(evaluateRelease("rc", ${JSON.stringify(index)}, ${JSON.stringify({ candidateRoot })})));`], evaluatorRoot);
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString()) as { decision: string; gates: { id: string; status: string; reason: string; evidence_sha256: string | null }[] };
  };
  return { root, repo, candidate, out, emit, evaluate };
}

test("separate evaluator consumes the exact candidate surface when its complete observed closure matches", () => {
  const f = fixture(), child = f.emit();
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(f.candidate).not.toBe(git(EVALUATOR_ROOT, ["rev-parse", "HEAD"]));
  const reference = JSON.parse(child.stdout.toString());
  const result = f.evaluate(reference, f.candidate, EVALUATOR_ROOT, f.repo);
  expect(result.decision).toBe("NO-GO");
  expect(result.gates.filter(row => row.status === "PASS").map(row => row.id)).toEqual(["evidence.index", SURFACE_GATE]);
  expect(result.gates.find(row => row.id === SURFACE_GATE)).toMatchObject({ status: "PASS", evidence_sha256: reference.sha256 });
  // The default still evaluates its own checkout, never discovers another one.
  expect(f.evaluate(reference, f.candidate, EVALUATOR_ROOT).gates.find(row => row.id === SURFACE_GATE))
    .toMatchObject({ status: "FAIL", reason: "candidate-head-mismatch", evidence_sha256: null });
}, 30_000);

test.each(["README.md", CAPABILITY_PROOF_FILE, "scripts/release-evidence.ts", "packages/cli/src/commands/app.ts", "packages/connectors/src/index.ts"])("separate surface evaluator refuses a changed reviewed closure: %s", path => {
  const f = fixture(), child = f.emit();
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const reference = JSON.parse(child.stdout.toString());
  appendFileSync(join(f.repo, path), "\n/* independently changed candidate bytes */\n");
  git(f.repo, ["add", path]); git(f.repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Change observed candidate source"]);
  const changed = git(f.repo, ["rev-parse", "HEAD"]);
  expect(f.evaluate(reference, changed, EVALUATOR_ROOT, f.repo).gates.find(row => row.id === SURFACE_GATE))
    .toMatchObject({ status: "FAIL", reason: "surface-producer-or-product-unreviewed", evidence_sha256: null });
}, 30_000);

test("separate surface evaluator retains wrong-head, dirty-checkout and receipt-integrity refusals", () => {
  const f = fixture(), child = f.emit();
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const reference = JSON.parse(child.stdout.toString());
  expect(f.evaluate(reference, "a".repeat(40), EVALUATOR_ROOT, f.repo).gates.find(row => row.id === SURFACE_GATE))
    .toMatchObject({ status: "FAIL", reason: "candidate-head-mismatch", evidence_sha256: null });
  const original = readFileSync(join(f.repo, "README.md"));
  appendFileSync(join(f.repo, "README.md"), "\ndirty\n");
  expect(f.evaluate(reference, f.candidate, EVALUATOR_ROOT, f.repo).gates.find(row => row.id === SURFACE_GATE))
    .toMatchObject({ status: "FAIL", reason: "candidate-worktree-dirty", evidence_sha256: null });
  writeFileSync(join(f.repo, "README.md"), original);
  expect(f.evaluate({ ...reference, sha256: "a".repeat(64) }, f.candidate, EVALUATOR_ROOT, f.repo).gates.find(row => row.id === SURFACE_GATE))
    .toMatchObject({ status: "FAIL", reason: "receipt-digest-mismatch", evidence_sha256: null });
}, 30_000);

test("surface CLI accepts only an exact candidate and a new absolute output", () => {
  expect(parseCapabilityArgs(["--out", "/tmp/surface.json", "--candidate", "a".repeat(40)])).toEqual({ candidate: "a".repeat(40), out: "/tmp/surface.json" });
  for (const args of [[], ["--candidate", "a".repeat(40)], ["--out", "relative", "--candidate", "a".repeat(40)],
    ["--candidate", "HEAD", "--out", "/tmp/surface.json"], ["--candidate", "a".repeat(40), "--out", "/tmp/x/../surface.json"],
    ["--candidate", "a".repeat(40), "--out", "/tmp/surface.json", "--out", "/tmp/again.json"], ["--help"]]) {
    expect(() => parseCapabilityArgs(args)).toThrow();
  }
});

test("actual producer receipt receives only compiled surface and doc-byte credit", () => {
  const f = fixture(), start = Date.now(), child = f.emit();
  expect(child.exitCode, child.stderr.toString()).toBe(0); expect(child.stderr.toString()).toBe("");
  const reference = JSON.parse(child.stdout.toString()), receipt = JSON.parse(readFileSync(f.out, "utf8"));
  expect(reference).toEqual({ producer: SURFACE_PRODUCER, gate_id: SURFACE_GATE, target: null, path: f.out, sha256: hash(readFileSync(f.out)) });
  expect(lstatSync(f.out).mode & 0o777).toBe(0o600); expect(lstatSync(f.out).nlink).toBe(1);
  expect(receipt.identity).toMatchObject({ candidate_source_sha: f.candidate, producer: SURFACE_PRODUCER,
    producer_files: ["scripts/capability-proof.ts", "scripts/release-evidence.ts"], source_class: "candidate-tree-inventory", actor_class: "automated-producer" });
  expect(receipt.identity.attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Date.parse(receipt.identity.recorded_at)).toBeGreaterThanOrEqual(start);
  expect(Date.parse(receipt.identity.recorded_at)).toBeLessThanOrEqual(Date.now());
  expect(receipt.docs.files).toEqual(SURFACE_DOC_FILES.map(path => ({ path, sha256: hash(readFileSync(join(f.repo, path))) })));
  expect(receipt.cli_verbs).toContain("app"); expect(receipt.mcp_tools).toContain("search");
  expect(receipt.connectors_c3).toHaveLength(15);
  const result = f.evaluate(reference);
  expect(result.decision).toBe("NO-GO");
  expect(result.gates.filter(row => row.status === "PASS").map(row => row.id)).toEqual(["evidence.index", SURFACE_GATE]);
  expect(result.gates.find(row => row.id === SURFACE_GATE)).toMatchObject({ status: "PASS", evidence_sha256: reference.sha256 });
  expect(readdirSync(f.root).some(name => name.startsWith(".kizuki-surface-publish-"))).toBe(false);

  for (const mutate of [
    (value: any) => { value.identity.candidate_source_sha = "a".repeat(40); },
    (value: any) => { value.identity.producer_revision = "a".repeat(64); },
    (value: any) => { value.identity.producer_files = ["README.md"]; },
    (value: any) => { value.docs.files[0].sha256 = "a".repeat(64); },
    (value: any) => { value.cli_verbs = []; },
    (value: any) => { value.disagreements = [{ code: "docs-mismatch", path: "docs.files" }]; },
    (value: any) => { value.identity.actor_class = "independent-witness"; },
  ]) {
    const forged = structuredClone(receipt); mutate(forged); writeFileSync(f.out, JSON.stringify(forged));
    const denied = f.evaluate({ ...reference, sha256: hash(readFileSync(f.out)) }).gates.find(row => row.id === SURFACE_GATE)!;
    expect(denied.status).toBe("FAIL"); expect(denied.evidence_sha256).toBeNull();
  }
  writeFileSync(f.out, JSON.stringify(receipt));
  const restoredReference = { ...reference, sha256: hash(readFileSync(f.out)) };
  for (const path of ["README.md", CAPABILITY_PROOF_FILE, "scripts/release-evidence.ts", "packages/cli/src/commands/app.ts"]) {
    const original = readFileSync(join(f.repo, path));
    appendFileSync(join(f.repo, path), "\n/* changed after receipt */\n");
    const denied = f.evaluate(restoredReference).gates.find(row => row.id === SURFACE_GATE)!;
    expect(denied.status).toBe("FAIL"); expect(denied.evidence_sha256).toBeNull();
    writeFileSync(join(f.repo, path), original);
  }
}, 60_000);

test.each(["head", "worktree", "index", "untracked", "alias", "normalized-doc", "normalized-import", "metadata", "dynamic"])("producer refuses unprovable %s candidate without a receipt", mode => {
  const f = fixture(); let candidate = f.candidate;
  if (mode === "head") candidate = "a".repeat(40);
  if (mode === "worktree") appendFileSync(join(f.repo, "README.md"), "\nchanged\n");
  if (mode === "index") { appendFileSync(join(f.repo, "README.md"), "\nchanged\n"); git(f.repo, ["add", "README.md"]); }
  if (mode === "untracked") writeFileSync(join(f.repo, "unexpected.txt"), "synthetic");
  if (mode === "alias") {
    appendFileSync(join(f.repo, ".gitignore"), "\nignored-source-alias\n");
    git(f.repo, ["add", ".gitignore"]); git(f.repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Record ignored alias name"]);
    candidate = git(f.repo, ["rev-parse", "HEAD"]); symlinkSync("packages", join(f.repo, "ignored-source-alias"));
  }
  if (mode === "normalized-doc" || mode === "normalized-import" || mode === "metadata") {
    const path = mode === "normalized-doc" ? "README.md" : mode === "normalized-import" ? "packages/cli/src/commands/app.ts" : "packages/cli/package.json";
    appendFileSync(join(f.repo, ".gitattributes"), `\n${path} text eol=lf\n`);
    git(f.repo, ["add", ".gitattributes"]); git(f.repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Bind LF source bytes"]);
    candidate = git(f.repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(f.repo, path), readFileSync(join(f.repo, path), "utf8").replace(/\r?\n/g, "\r\n"));
    git(f.repo, ["add", path]); expect(git(f.repo, ["status", "--porcelain"])).toBe("");
  }
  if (mode === "dynamic") {
    appendFileSync(join(f.repo, "packages/cli/src/commands/app.ts"), '\nconst unprovableSurfaceModule = "./app"; if (false) void import(unprovableSurfaceModule);\n');
    git(f.repo, ["add", "packages/cli/src/commands/app.ts"]); git(f.repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "Include unsupported dynamic graph"]);
    candidate = git(f.repo, ["rev-parse", "HEAD"]);
  }
  const child = f.emit(["--candidate", candidate, "--out", f.out]);
  expect(child.exitCode).toBe(2); expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toContain("no surface receipt credited");
  expect(existsSync(f.out)).toBe(false);
  expect(readdirSync(f.root).some(name => name.startsWith(".kizuki-surface-publish-"))).toBe(false);
}, 30_000);

test("producer refuses unsafe or existing output and preserves competing bytes", () => {
  const f = fixture(); writeFileSync(f.out, "existing evidence");
  expect(f.emit().exitCode).toBe(2); expect(readFileSync(f.out, "utf8")).toBe("existing evidence");
  const alias = join(f.root, "alias"); symlinkSync(f.root, alias, "dir");
  for (const out of [join(alias, "other.json"), join(f.repo, "forbidden.json")]) {
    expect(f.emit(["--candidate", f.candidate, "--out", out]).exitCode).toBe(2);
    expect(existsSync(out)).toBe(false);
  }
  const leaf = join(f.root, "leaf.json"); symlinkSync(f.out, leaf);
  expect(f.emit(["--candidate", f.candidate, "--out", leaf]).exitCode).toBe(2);
  expect(lstatSync(leaf).isSymbolicLink()).toBe(true); expect(readFileSync(f.out, "utf8")).toBe("existing evidence");
  expect(git(f.repo, ["status", "--porcelain"])).toBe("");
}, 30_000);

test.each(["write", "sync", "competing-output", "source-change"])("publication refuses %s without partial evidence", mode => {
  const f = fixture();
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const write = fs.writeFileSync, sync = fs.fsyncSync, mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(f.out)};
    let injected = false;
    mock.module("node:fs", () => ({ ...fs,
      writeFileSync(target, bytes, ...args) {
        if (mode === "write" && typeof target === "number" && !injected) {
          injected = true; write(target, String(bytes).slice(0, 7), ...args); throw new Error("synthetic disk full");
        }
        return write(target, bytes, ...args);
      },
      fsyncSync(fd) {
        if (!injected) {
          injected = true;
          if (mode === "sync") throw new Error("synthetic sync failure");
          if (mode === "competing-output") write(out, "competing evidence", { flag: "wx", mode: 0o600 });
          if (mode === "source-change") fs.appendFileSync(${JSON.stringify(join(f.repo, "README.md"))}, "\\nchanged while staging\\n");
        }
        return sync(fd);
      },
    }));
    const { runCapabilityProof } = await import(${JSON.stringify(join(f.repo, CAPABILITY_PROOF_FILE))});
    let failed = false;
    try { runCapabilityProof({ candidate: ${JSON.stringify(f.candidate)}, out }); } catch { failed = true; }
    process.stdout.write(JSON.stringify({ failed, injected, final: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null,
      pending: fs.readdirSync(${JSON.stringify(f.root)}).filter(name => name.startsWith(".kizuki-surface-publish-")) }));
  `;
  const child = command([process.execPath, "--eval", script], f.repo);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ failed: true, injected: true,
    final: mode === "competing-output" ? "competing evidence" : null, pending: [] });
}, 30_000);
