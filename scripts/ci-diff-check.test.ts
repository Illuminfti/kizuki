import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "ci-diff-check.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-ci-range-"));
  roots.push(root);
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  git("init", "-q");
  git("config", "user.name", "Synthetic CI");
  git("config", "user.email", "ci@example.invalid");
  function commit(text: string) {
    writeFileSync(join(root, "fixture.txt"), text);
    git("add", "fixture.txt"); git("commit", "-qm", "Change fixture");
    return git("rev-parse", "HEAD");
  }
  function check(name: string, event: unknown, eventSha?: string) {
    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    return Bun.spawnSync([process.execPath, script], {
      cwd: root, env: { ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: eventSha ?? "" },
      stdout: "pipe", stderr: "pipe",
    });
  }
  return { git, commit, check };
}

test("push checks the event range even when origin/main already names HEAD", () => {
  const f = fixture(); const before = f.commit("clean\n"); const after = f.commit("bad  \n");
  f.git("update-ref", "refs/remotes/origin/main", after);
  expect(f.git("diff", "--check", "origin/main...HEAD")).toBe("");
  const result = f.check("push", { before, after });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("trailing whitespace");
});

test("pull request checks its immutable head against its merge base", () => {
  const f = fixture(); const base = f.commit("clean\n"); const head = f.commit("good\n");
  expect(f.check("pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }).exitCode).toBe(0);
  const wrongHead = f.check("pull_request", { pull_request: { base: { sha: base }, head: { sha: base } } });
  expect(wrongHead.exitCode).not.toBe(0);
});

test("a newly created branch checks its whole tree and invalid or missing SHAs refuse", () => {
  const f = fixture(); const after = f.commit("bad  \n");
  expect(f.check("push", { before: "0".repeat(40), after }).exitCode).not.toBe(0);
  for (const before of ["", "HEAD~1", "-x", "f".repeat(40)]) {
    expect(f.check("push", { before, after }).exitCode).not.toBe(0);
  }
  expect(f.check("push", { before: after, after: "0".repeat(40) }).exitCode).not.toBe(0);
  expect(f.check("workflow_dispatch", {}).exitCode).not.toBe(0);
});

test("clean push and initial clean tree pass with reported exact endpoints", () => {
  const f = fixture(); const before = f.commit("clean\n"); const after = f.commit("also clean\n");
  for (const start of [before, "0".repeat(40)]) {
    const result = f.check("push", { before: start, after });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(after);
  }
});


test("manual native proof binds explicit ancestor base and actual event SHA", () => {
  const f = fixture(); const base = f.commit("clean\n"); const head = f.commit("new\n");
  expect(f.check("workflow_dispatch", { inputs: { base_sha: base } }, head).exitCode).toBe(0);
  for (const bad of ["", "HEAD~1", "0".repeat(40), "f".repeat(40), head]) {
    expect(f.check("workflow_dispatch", { inputs: { base_sha: bad } }, head).exitCode).not.toBe(0);
  }
  expect(f.check("workflow_dispatch", { inputs: { base_sha: base } }, base).exitCode).not.toBe(0);
  expect(f.check("workflow_dispatch", { inputs: { base_sha: base } }).exitCode).not.toBe(0);
  f.git("checkout", "--detach", base); const sibling = f.commit("sibling\n"); f.git("checkout", "--detach", head);
  expect(f.check("workflow_dispatch", { inputs: { base_sha: sibling } }, head).exitCode).not.toBe(0);
});
