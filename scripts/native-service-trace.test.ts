import { expect, test } from "bun:test";
import { projectNativeSyscallTrace, syntheticTraceTargetMatches } from "./native-service-trace";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("native syscall diagnostics retain operation and errno without buffers or private paths", () => {
  const root = "/tmp/synthetic-fixture";
  const raw = [
    '201 openat(5, ".kizuki", O_RDONLY|O_NOFOLLOW) = 7',
    '201 openat(7, "serve-stop.json", O_RDONLY) = -1 EROFS (Read-only file system)',
    '201 read(7, "TOKEN_CANARY_NEVER_OUTPUT", 128) = 24',
    '201 newfstatat(7, "/outside/PRIVATE_CANARY_NEVER_OUTPUT", {arbitrary="CANARY_NEVER_OUTPUT"}, 0) = -1 EACCES (Permission denied)',
    '201 openat(7, "/tmp/synthetic-fixture/home/PRIVATE_CANARY_NEVER_OUTPUT", O_RDONLY) = 9',
    'sudo: PRIVATE_CANARY_NEVER_OUTPUT',
  ].join("\n");
  const output = projectNativeSyscallTrace(raw, root);
  expect(output.rows).toHaveLength(5);
  expect(output.rows[1]).toEqual({ syscall: "openat", result: -1, errno: "EROFS", path: "serve-stop.json" });
  expect(output.rows[2]!.path).toBe("<relative-path>");
  expect(output.rows[3]!.path).toBe("<external-path>");
  expect(output.rows[4]!.path).toBe("<fixture-path>");
  expect(JSON.stringify(output)).not.toContain("CANARY");
  expect(JSON.stringify(output)).not.toContain("/outside");
});

test("native syscall diagnostics bound width and discard unsupported lines", () => {
  const output = projectNativeSyscallTrace('openat(3, ".", O_RDONLY) = 5\n'.repeat(10_000), "/synthetic");
  expect(output.rows).toHaveLength(120); expect(output.truncated).toBe(true);
  expect(JSON.stringify(output).length).toBeLessThan(16_384);
  expect(projectNativeSyscallTrace('execve("SECRET", [], []) = 0', "/synthetic").rows).toEqual([]);
  expect(projectNativeSyscallTrace('openat(3, ".", 0) = -1 E_PRIVATE_CANARY', "/synthetic").rows[0]!.errno).toBeNull();
});

test("routine calls cannot crowd out later directory and descriptor errors", () => {
  const ordinary = 'openat(3, ".", O_RDONLY) = 5\n';
  const output = projectNativeSyscallTrace(ordinary.repeat(200) +
    'getdents64(5, 0x123456, 0x1000) = -1 EBADF (Bad file descriptor)\n' +
    'readlinkat(5, 0x123456, 0x654321, 0x1000) = -1 EACCES (Permission denied)\n' + ordinary.repeat(200), "/synthetic");
  expect(output.rows.length).toBeLessThanOrEqual(160);
  expect(output.rows.filter(row => row.errno !== null).map(row => [row.syscall, row.errno]))
    .toEqual([["getdents64", "EBADF"], ["readlinkat", "EACCES"]]);
  expect(JSON.stringify(output)).not.toContain("0x123456");
});

test("native trace cannot target this process or arbitrary paths outside the synthetic CI contract", () => {
  expect(syntheticTraceTargetMatches({ fixtureRoot: "/tmp", vault: "/tmp/synthetic vault", binary: process.execPath,
    pid: process.pid, instanceId: "fabricated" })).toBe(false);
});

test.skipIf(process.platform !== "linux")("target gate binds a real synthetic child executable, cwd, argv and exact marker", async () => {
  const runner = mkdtempSync(join(tmpdir(), "native-trace-runner-"));
  const fixtureRoot = mkdtempSync(join(runner, "kizuki native lifecycle "));
  const vault = join(fixtureRoot, "synthetic vault"), binary = join(fixtureRoot, "installed package", "kizuki");
  mkdirSync(join(vault, ".kizuki"), { recursive: true }); mkdirSync(join(fixtureRoot, "installed package"));
  const entry = join(fixtureRoot, "child.ts"); writeFileSync(entry, "await Bun.sleep(30000);\n");
  const built = await Bun.build({ entrypoints: [entry], compile: { target: "bun-linux-x64-baseline", outfile: binary } });
  expect(built.success).toBe(true);
  const child = Bun.spawn([binary, "serve", "--vault", vault], { cwd: vault, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const previous = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, CI: process.env.CI, RUNNER_TEMP: process.env.RUNNER_TEMP };
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: "true", CI: "true", RUNNER_TEMP: runner });
    const target = { fixtureRoot, vault, binary, pid: child.pid, instanceId: "synthetic-instance" };
    writeFileSync(join(vault, ".kizuki/serve.pid"), JSON.stringify({ pid: child.pid, instance_id: target.instanceId }), { mode: 0o600 });
    await Bun.sleep(100);
    expect(syntheticTraceTargetMatches(target)).toBe(true);
    expect(syntheticTraceTargetMatches({ ...target, instanceId: "stale" })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, pid: process.pid })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, binary: process.execPath })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, vault: fixtureRoot })).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    child.kill("SIGTERM"); await child.exited; rmSync(runner, { recursive: true, force: true });
  }
});
