import { expect, test } from "bun:test";
import { captureSyntheticServiceIdentity, projectNativeIdMap, projectNativeSyscallTrace, syntheticTraceTargetMatches } from "./native-service-trace";
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

test("successful stat calls retain bounded numeric ownership, mode and device identity only", () => {
  const output = projectNativeSyscallTrace([
    'statx(17, "", AT_EMPTY_PATH, STATX_BASIC_STATS, {stx_mask=STATX_ALL, stx_uid=65534, stx_gid=65534, stx_mode=S_IFDIR|0755, stx_ino=18446744073709551615, stx_size=4096, stx_atime={tv_sec=123, tv_nsec=456}, stx_dev_major=252, stx_dev_minor=0}) = 0',
    'newfstatat(3, ".", {st_dev=makedev(0x8, 0x1), st_ino=22, st_mode=S_IFDIR|0700, st_uid=1000, st_gid=1001, st_size=PRIVATE_CANARY}, AT_SYMLINK_NOFOLLOW) = 0',
    'fstat(3, {st_dev=2049, st_ino=0x2a, st_mode=0100600, st_uid=0, st_gid=0}) = 0',
  ].join("\n"), "/synthetic");
  expect(output.rows.map(row => row.metadata)).toEqual([
    { uid: 65534, gid: 65534, mode: 0o040755, type: 0o040000, ino: "18446744073709551615", dev_major: 252, dev_minor: 0 },
    { uid: 1000, gid: 1001, mode: 0o040700, type: 0o040000, ino: "22", dev_major: 8, dev_minor: 1 },
    { uid: 0, gid: 0, mode: 0o100600, type: 0o100000, ino: "42", dev: "2049" },
  ]);
  expect(JSON.stringify(output)).not.toContain("PRIVATE_CANARY");
  expect(JSON.stringify(output)).not.toContain("tv_sec");
});

test.each([
  'stx_uid=-1', 'stx_uid=4294967296', 'stx_uid=1.5', 'stx_uid=1000, stx_uid=0',
  'stx_ino=18446744073709551616', 'stx_mode=S_IFCANARY|0755', 'stx_mode=0777777',
  'stx_dev_major=4294967296', 'stx_uid="PRIVATE_CANARY"',
])("stat metadata refuses malformed numeric fields: %s", fields => {
  const output = projectNativeSyscallTrace(`statx(17, "", 0, 0, {${fields}}) = 0`, "/synthetic");
  expect(output.rows).toHaveLength(1); expect(output.rows[0]!.metadata).toBeUndefined();
  expect(JSON.stringify(output)).not.toContain("CANARY");
});

test("stat metadata never comes from paths, nested fields, failed calls or read buffers", () => {
  const output = projectNativeSyscallTrace([
    'statx(17, "{stx_uid=1234}", 0, 0, {stx_atime={stx_uid=5678}}) = 0',
    'statx(17, "", 0, 0, {stx_uid=1000, stx_gid=1000}) = -1 EIO (error)',
    'read(17, "{stx_uid=1000}", 32) = 0',
  ].join("\n"), "/synthetic");
  expect(output.rows.every(row => row.metadata === undefined)).toBe(true);
});

test("namespace maps retain only bounded nonoverlapping numeric triplets", () => {
  expect(projectNativeIdMap("         0          0 4294967295\n")).toEqual([{ inside: 0, outside: 0, length: 4294967295 }]);
  expect(projectNativeIdMap("0 1000 1\n1 100000 65536\n")).toEqual([
    { inside: 0, outside: 1000, length: 1 }, { inside: 1, outside: 100000, length: 65536 },
  ]);
  for (const malformed of ["", "0 0 1", "0 0 0\n", "-1 0 1\n", "0 0 4294967296\n", "0 4294967295 1\n",
    "0 0 2\n1 5 1\n", "0 0 1\n5 0 1\n", "0 0 1 PRIVATE_CANARY\n", "0 0 1\n".repeat(341), "0".repeat(16_385)]) {
    expect(projectNativeIdMap(malformed)).toBeNull();
  }
});

test("native trace cannot target this process or arbitrary paths outside the synthetic CI contract", () => {
  const target = { fixtureRoot: "/tmp", vault: "/tmp/synthetic vault", binary: process.execPath, pid: process.pid, instanceId: "fabricated" };
  expect(syntheticTraceTargetMatches(target)).toBe(false);
  expect(captureSyntheticServiceIdentity(target)).toEqual({ status: "target_unverified" });
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
    const identity = captureSyntheticServiceIdentity(target);
    expect(identity.status).toBe("captured");
    expect(identity.uid_map?.length).toBeGreaterThan(0);
    expect(identity.gid_map?.length).toBeGreaterThan(0);
    expect(identity.root?.type).toBe(0o040000);
    expect(JSON.stringify(identity)).not.toContain(fixtureRoot);
    expect(captureSyntheticServiceIdentity({ ...target, instanceId: "stale" })).toEqual({ status: "target_unverified" });
    expect(syntheticTraceTargetMatches({ ...target, instanceId: "stale" })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, pid: process.pid })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, binary: process.execPath })).toBe(false);
    expect(syntheticTraceTargetMatches({ ...target, vault: fixtureRoot })).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    child.kill("SIGTERM"); await child.exited; rmSync(runner, { recursive: true, force: true });
  }
});
