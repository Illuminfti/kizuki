import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureLaunchctlOperation, launchctlFixtureMatches, observeLaunchctl, projectLaunchctlResult, syntheticServiceFileMetadata, prepareLaunchctlStartupCapture, startupCapturePlist, type LaunchctlFixture } from "./native-launchctl-diagnostics";

const fixture: LaunchctlFixture = { root: "/synthetic/kizuki native lifecycle fixed", runner_temp: "/synthetic", uid: 501,
  vault_id: "synthetic-vault", binary: { dev: 1, ino: 2, size: 3, mtime_ms: 4 } };
const target = "gui/501/dev.kizuki.synthetic-vault";
const unit = join(fixture.root, "home/Library/LaunchAgents/dev.kizuki.synthetic-vault.plist");

test("only exact owned print, bootout and bootstrap argument vectors qualify", () => {
  expect(fixtureLaunchctlOperation(fixture, ["print", target])).toBe("print");
  expect(fixtureLaunchctlOperation(fixture, ["bootout", target])).toBe("bootout");
  expect(fixtureLaunchctlOperation(fixture, ["bootstrap", "gui/501", unit])).toBe("bootstrap");
  for (const argv of [["print", "gui/501"], ["print", target, "--extra"], ["bootout", "system"],
    ["bootout", target + "-other"], ["bootstrap", "gui/0", unit], ["bootstrap", "gui/501", unit + "-other"],
    ["bootstrap", "gui/501", unit.replace("LaunchAgents/", "LaunchAgents/../LaunchAgents/")],
    ["setenv", "PRIVATE", "CANARY"], ["print", target.replace("501", "502")]]) {
    expect(fixtureLaunchctlOperation(fixture, argv)).toBeNull();
  }
  expect(fixtureLaunchctlOperation({ ...fixture, vault_id: "../foreign" }, ["print", target])).toBeNull();
  expect(fixtureLaunchctlOperation({ ...fixture, uid: 0 }, ["print", target])).toBeNull();
});

test("native output is projected to closed fields, never configuration or arbitrary stderr", () => {
  const row = projectLaunchctlResult("print", { exit_code: 0, signal: null,
    stdout: "state = running\npid = 501\nlast exit code = 78\nenvironment = { TOKEN = PRIVATE_CANARY }\nnote state = exited\n",
    stderr: "PRIVATE_CANARY input/output error /private/secret" }, 12.1);
  expect(row).toEqual({ operation: "print", exit_code: 0, signal: null, duration_ms: 12, state: "running", pid: 501,
    last_exit_code: 78, error: "input_output_error", output_truncated: false });
  expect(JSON.stringify(row)).not.toContain("PRIVATE");
  expect(projectLaunchctlResult("print", { exit_code: 113, signal: null, stdout: "note pid = 99\nstate = UNTRUSTED", stderr: "Could not find service" }, 0))
    .toMatchObject({ exit_code: 113, pid: null, state: null, error: "service_absent" });
  expect(projectLaunchctlResult("bootstrap", { exit_code: 5, signal: null, stdout: "x".repeat(65_537), stderr: "unknown-private-detail" }, 0))
    .toMatchObject({ error: "unclassified", output_truncated: true });
});

test("observer delegates exact absolute command and preserves failure, output and signal", () => {
  const actual = { exit_code: 5, stdout: "native stdout", stderr: "Input/output error PRIVATE_CANARY", signal: null };
  const rows: unknown[] = [];
  const result = observeLaunchctl("bootstrap", ["bootstrap", "gui/501", unit], argv => {
    expect(argv).toEqual(["/bin/launchctl", "bootstrap", "gui/501", unit]); return actual;
  }, row => rows.push(row));
  expect(result).toBe(actual); expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_CANARY");
  const signaled = { ...actual, exit_code: 137, signal: 9 };
  expect(observeLaunchctl("bootout", ["bootout", target], () => signaled, () => { throw new Error("record failure"); })).toBe(signaled);
});

test("the actual wrapper refuses non-CI execution before any native call", () => {
  expect(launchctlFixtureMatches(fixture)).toBe(false);
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { runFixtureLaunchctl } from ${JSON.stringify(join(import.meta.dir, "native-launchctl-diagnostics.ts"))};
    runFixtureLaunchctl(${JSON.stringify(fixture)}, ['bootout', ${JSON.stringify(target)}]);
  `], { env: { PATH: "/usr/bin:/bin", HOME: tmpdir() }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode).toBe(126);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("synthetic launchctl diagnostic target refused\n");
});

test("the real supervisor resolves its CLI child PATH without changing the parent environment", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchctl-path-"));
  const wrapper = join(root, "launchctl"), receipt = join(root, "argv");
  const oldPath = process.env.PATH;
  try {
    writeFileSync(wrapper, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('state = running\\npid = 501\\ndisabled = 0\\nenvironment = { SERVICE_DISABLED = 1 }');\n`, { mode: 0o700 });
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { realSupervisorHost } from ${JSON.stringify(join(import.meta.dir, "../packages/core/src/serve/supervisor.ts"))};
      const result = realSupervisorHost('launchd', ${JSON.stringify(root)}, '/synthetic/binary').query('synthetic-vault');
      if (result.state !== 'active' || !result.enabled) process.exit(1);
    `], { env: { PATH: `${root}:/usr/bin:/bin`, HOME: root }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(["print", `gui/${process.getuid?.() ?? 0}/dev.kizuki.synthetic-vault`]);
    expect(process.env.PATH).toBe(oldPath);
  } finally { rmSync(root, { recursive: true }); }
});

test("failure metadata leaves journal content unread and preserves symlink identity", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchctl-metadata-"));
  const folder = join(root, "synthetic vault/.kizuki"), journal = join(folder, "service-change.json");
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(journal, "PRIVATE_JOURNAL_CANARY", { mode: 0o600 });
    symlinkSync("does-not-exist", join(folder, "serve.pid"));
    const actual = syntheticServiceFileMetadata(root, "synthetic-vault");
    expect(actual.journal).toMatchObject({ exists: true, regular: true, symlink: false, mode: 0o600, size: 22 });
    expect(actual.marker).toMatchObject({ exists: true, regular: false, symlink: true });
    expect(actual.unit).toEqual({ exists: false });
    expect(JSON.stringify(actual)).not.toContain("PRIVATE_JOURNAL_CANARY");
    expect(readFileSync(journal, "utf8")).toBe("PRIVATE_JOURNAL_CANARY");
    // ENOTDIR is a failed metadata observation, not evidence that the journal is absent.
    expect(syntheticServiceFileMetadata(journal, "synthetic-vault").journal)
      .toEqual({ exists: null, error: "metadata_unavailable" });
  } finally { rmSync(root, { recursive: true }); }
});


test("fixture guard binds real files and rejects aliases, tampering and wrong source identity", () => {
  // Only the platform label is simulated for this filesystem guard unit test.
  // No native command is invoked; actual Darwin qualification remains CI's job.
  const script = `
    import { strict as assert } from 'node:assert';
    import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { launchctlFixtureMatches, bindInitializedLaunchctlFixture } from ${JSON.stringify(join(import.meta.dir, "native-launchctl-diagnostics.ts"))};
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const runner = realpathSync(mkdtempSync(join(tmpdir(), 'kizuki-launchctl-guard-')));
    const root = mkdtempSync(join(runner, 'kizuki native lifecycle '));
    const id = join(root, 'synthetic vault/.kizuki/vault-id'), binary = join(root, 'installed package/kizuki'), trace = join(root, 'launchctl diagnostics/commands.jsonl');
    for (const folder of ['synthetic vault/.kizuki', 'installed package', 'launchctl diagnostics']) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
    writeFileSync(id, 'synthetic-vault', { mode: 0o600 }); writeFileSync(binary, 'synthetic-binary', { mode: 0o700 }); writeFileSync(trace, '', { mode: 0o600 });
    const s = lstatSync(binary);
    const fixture = { root, runner_temp: runner, uid: process.getuid(), vault_id: 'synthetic-vault', binary: { dev: s.dev, ino: s.ino, size: s.size, mtime_ms: s.mtimeMs } };
    Object.assign(process.env, { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: runner });
    try {
      assert.equal(launchctlFixtureMatches(fixture), true);
      const { vault_id, ...pending } = fixture;
      assert.equal(bindInitializedLaunchctlFixture(pending).vault_id, vault_id);
      unlinkSync(id); assert.throws(() => bindInitializedLaunchctlFixture(pending)); writeFileSync(id, 'synthetic-vault', { mode: 0o600 });
      writeFileSync(id, '../foreign'); assert.throws(() => bindInitializedLaunchctlFixture(pending)); writeFileSync(id, 'synthetic-vault');
      chmodSync(id, 0o644); assert.throws(() => bindInitializedLaunchctlFixture(pending)); chmodSync(id, 0o600);
      assert.throws(() => bindInitializedLaunchctlFixture({ ...pending, binary: { ...pending.binary, ino: 0 } }));
      process.env.CI = 'false'; assert.equal(launchctlFixtureMatches(fixture), false); process.env.CI = 'true';
      assert.equal(launchctlFixtureMatches({ ...fixture, runner_temp: root }), false);
      assert.equal(launchctlFixtureMatches({ ...fixture, uid: fixture.uid + 1 }), false);
      assert.equal(launchctlFixtureMatches({ ...fixture, root: root + '/.' }), false);
      assert.equal(launchctlFixtureMatches({ ...fixture, binary: { ...fixture.binary, ino: fixture.binary.ino + 1 } }), false);
      writeFileSync(id, 'foreign-vault'); assert.equal(launchctlFixtureMatches(fixture), false); writeFileSync(id, 'synthetic-vault');
      chmodSync(id, 0o644); assert.equal(launchctlFixtureMatches(fixture), false); chmodSync(id, 0o600);
      unlinkSync(trace); symlinkSync(id, trace); assert.equal(launchctlFixtureMatches(fixture), false); unlinkSync(trace); writeFileSync(trace, '', { mode: 0o600 });
      writeFileSync(trace, 'x'.repeat(65537)); assert.equal(launchctlFixtureMatches(fixture), false); writeFileSync(trace, '');
      writeFileSync(binary, 'changed-binary'); assert.equal(launchctlFixtureMatches(fixture), false);
    } finally { rmSync(runner, { recursive: true }); }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
});


test("startup capture changes only output paths and refuses unexpected definitions", () => {
  const source = "<plist>\n<dict>\n<key>KeepAlive</key><true/>\n</dict>\n</plist>\n";
  const clone = startupCapturePlist(source, source, "/synthetic/a&b", "/synthetic/error");
  expect(clone).toContain("<key>KeepAlive</key><true/>");
  expect(clone).toContain("/synthetic/a&amp;b");
  expect(clone.replace(/  <key>StandardOutPath<\/key>[\s\S]*?<\/string>\n  <key>StandardErrorPath<\/key>[\s\S]*?<\/string>\n/, "")).toBe(source);
  expect(() => startupCapturePlist(source + "extra", source, "/out", "/err")).toThrow("definition refused");
});

test("held startup capture bounds output and refuses replaced endpoints", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-startup-output-"));
  mkdirSync(join(root, "launchctl diagnostics"), { mode: 0o700 });
  const capture = prepareLaunchctlStartupCapture(root);
  try {
    writeFileSync(join(root, "launchctl diagnostics/startup-stderr.log"), "startup_failure\n" + "x".repeat(9000));
    const observed = capture.collect();
    expect(observed).toMatchObject({ changed_native_configuration: true, release_eligible: false, timing_changed: true });
    expect(observed.output.stderr).toMatchObject({ bytes_read: 8192, truncated: true });
    expect(observed.output.stderr!.text).toStartWith("startup_failure\n");
    rmSync(join(root, "launchctl diagnostics/startup-stdout.log"));
    symlinkSync("startup-stderr.log", join(root, "launchctl diagnostics/startup-stdout.log"));
    expect(() => capture.collect()).toThrow("custody refused");
  } finally { capture.close(); capture.close(); rmSync(root, { recursive: true }); }
});

test("synthetic bootstrap clone retains original and actual subprocess startup failure", () => {
  // Simulate only platform admission; the callback runs an owned child, never launchctl.
  const script = `
    import { strict as assert } from 'node:assert';
    import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync, openSync, closeSync } from 'node:fs';
    import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { prepareLaunchctlStartupCapture, captureLaunchctlBootstrap } from ${JSON.stringify(join(import.meta.dir, "native-launchctl-diagnostics.ts"))};
    import { renderLaunchdPlist } from ${JSON.stringify(join(import.meta.dir, "../packages/core/src/serve/units.ts"))};
    import { DEFAULT_SERVE_CONFIG } from ${JSON.stringify(join(import.meta.dir, "../packages/core/src/serve/types.ts"))};
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const runner = realpathSync(mkdtempSync(join(tmpdir(), 'kizuki-capture-guard-'))), root = mkdtempSync(join(runner, 'kizuki native lifecycle '));
    for (const folder of ['synthetic vault/.kizuki', 'installed package', 'launchctl diagnostics', 'home/Library/LaunchAgents']) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
    const vault = join(root, 'synthetic vault'), binary = join(root, 'installed package/kizuki'), unit = join(root, 'home/Library/LaunchAgents/dev.kizuki.synthetic-vault.plist');
    writeFileSync(join(vault, '.kizuki/vault-id'), 'synthetic-vault', { mode: 0o600 }); writeFileSync(binary, 'synthetic-binary', { mode: 0o700 });
    writeFileSync(join(root, 'launchctl diagnostics/commands.jsonl'), '', { mode: 0o600 });
    const original = renderLaunchdPlist({ vaultPath: vault, vaultId: 'synthetic-vault', execStart: [binary, 'serve', '--vault', vault], config: DEFAULT_SERVE_CONFIG });
    writeFileSync(unit, original, { mode: 0o600 });
    const capture = prepareLaunchctlStartupCapture(root), s = lstatSync(binary);
    const fixture = { root, runner_temp: runner, uid: process.getuid(), vault_id: 'synthetic-vault', binary: { dev: s.dev, ino: s.ino, size: s.size, mtime_ms: s.mtimeMs }, startup_capture: capture.binding };
    Object.assign(process.env, { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: runner });
    let calls = 0;
    try {
      const result = captureLaunchctlBootstrap(fixture, ['bootstrap', 'gui/' + fixture.uid, unit], command => {
        calls++; assert.deepEqual(command.slice(0,3), ['/bin/launchctl', 'bootstrap', 'gui/' + fixture.uid]);
        assert.equal(command[3], join(root, 'launchctl diagnostics/startup.plist'));
        assert.equal(readFileSync(unit, 'utf8'), original);
        const clone = readFileSync(command[3], 'utf8'); assert.ok(clone.includes('<key>StandardErrorPath</key>'));
        const fd = openSync(join(root, 'launchctl diagnostics/startup-stderr.log'), 'a');
        try { const child = Bun.spawnSync([process.execPath, '--eval', 'console.error("SYNTHETIC_STARTUP_FATAL"); process.exit(1)'], { stdout: 'ignore', stderr: fd }); assert.equal(child.exitCode, 1); }
        finally { closeSync(fd); }
        return { exit_code: 0, stdout: '', stderr: '', signal: null };
      });
      assert.equal(result.exit_code, 0); assert.equal(calls, 1); assert.equal(readFileSync(unit, 'utf8'), original);
      const evidence = capture.collect(); assert.ok(evidence.output.stderr.text.includes('SYNTHETIC_STARTUP_FATAL'));
      assert.equal(JSON.parse(evidence.output.metadata.text).original_preserved, true);
      assert.throws(() => captureLaunchctlBootstrap(fixture, ['bootstrap', 'gui/0', unit], () => { calls++; throw Error('unreachable'); }));
      writeFileSync(unit, original.replace('<true/>', '<false/>'));
      assert.throws(() => captureLaunchctlBootstrap(fixture, ['bootstrap', 'gui/' + fixture.uid, unit], () => { calls++; throw Error('unreachable'); }));
      assert.equal(calls, 1);
    } finally { capture.close(); rmSync(runner, { recursive: true }); }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
});
