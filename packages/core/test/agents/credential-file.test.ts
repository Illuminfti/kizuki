import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCredentialDirectory, type CredentialFileInspection } from "../../src/agents/credential-file";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "kizuki-credential-file-"));
  roots.push(root); chmodSync(root, 0o700); return root;
}
function custodyPathIsQualified(path: string): boolean {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid === undefined) return false;
  const uid = BigInt(process.geteuid()); let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== uid)) return false;
    if ((stat.mode & 0o022n) !== 0n && (stat.uid !== 0n || (stat.mode & 0o1000n) === 0n)) return false;
    current = join(current, part);
  }
  const parent = lstatSync(current, { bigint: true });
  return parent.uid === uid && (parent.mode & 0o7777n) === 0o700n;
}
const probe = temporary();
const canExerciseCustody = custodyPathIsQualified(probe);

test.if(!canExerciseCustody)("refuses the uid-mapped ancestry instead of weakening custody", () => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    expect(() => openCredentialDirectory(temporary())).toThrow("credential_file_unsupported");
    return;
  }
  expect(() => openCredentialDirectory(temporary())).toThrow("credential_file_unsafe");
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("fixture");
  expect(statSync("/", { bigint: true }).uid).not.toBe(BigInt(uid));
});

test.if(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.arch === "x64")("requires a qualified Linux CI filesystem", () => {
  expect(canExerciseCustody).toBe(true);
});

test.if(canExerciseCustody && process.geteuid?.() !== 0)("refuses an euid-owned writable sticky ancestor", () => {
  const root = temporary(), sticky = join(root, "sticky"), child = join(sticky, "child");
  mkdirSync(sticky, { mode: 0o777 }); chmodSync(sticky, 0o1777); mkdirSync(child, { mode: 0o700 });
  expect(() => openCredentialDirectory(child)).toThrow("credential_file_unsafe");
});

test.if(canExerciseCustody)("creates, writes, syncs, and cleans up only a live creation", () => {
  const root = temporary(), directory = openCredentialDirectory(root), bytes = new Uint8Array([7, 23, 91, 4]);
  try {
    const created = directory.create("credential");
    expect(created.identity.dev).toMatch(/^[0-9]+$/); expect(created.identity.ino).toMatch(/^[0-9]+$/);
    directory.writeComplete(created, bytes); directory.syncAndVerify(created, bytes);
    const inspected = directory.inspect("credential"); if (inspected === null) throw new Error("fixture");
    expect(inspected.bytes).toEqual(bytes); expect(() => directory.removeCreated(inspected, bytes)).toThrow("credential_file_handle"); inspected.close();
    directory.removeCreated(created, bytes); expect(directory.inspect("credential")).toBeNull();
  } finally { directory.close(); }
});

test.if(canExerciseCustody)("cleanup preserves a changed inode until its own expected-byte verification succeeds", () => {
  const root = temporary(), directory = openCredentialDirectory(root), bytes = new Uint8Array([7, 23, 91, 4]);
  const created = directory.create("credential");
  try {
    directory.writeComplete(created, bytes);
    writeFileSync(join(root, "credential"), new Uint8Array([7, 23, 91, 5]));
    expect(() => directory.removeCreated(created, bytes)).toThrow("credential_file_changed");
    expect(readFileSync(join(root, "credential")).equals(Buffer.from([7, 23, 91, 5]))).toBe(true);
  } finally { created.close(); directory.close(); }
});

test.if(canExerciseCustody)("inspects a large qualified file by metadata without reading credential bytes", () => {
  const root = temporary(), directory = openCredentialDirectory(root), file = join(root, "kizuki.db");
  try {
    writeFileSync(file, new Uint8Array(1025)); chmodSync(file, 0o600);
    utimesSync(file, new Date("2001-01-01"), new Date("2020-01-01"));
    const found = directory.inspectFileIdentity("kizuki.db");
    expect(found).not.toBeNull(); expect(found?.ino).toMatch(/^[0-9]+$/);
    const stat = lstatSync(file, { bigint: true });
    expect(found).toEqual({ dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
      mode: stat.mode.toString(), uid: stat.uid.toString(), gid: stat.gid.toString(), nlink: stat.nlink.toString(),
      mtime_ns: stat.mtimeNs.toString(), ctime_ns: stat.ctimeNs.toString() });
    expect(() => directory.inspect("kizuki.db")).toThrow("credential_file_bounds");
    symlinkSync(file, join(root, "link")); expect(() => directory.inspectFileIdentity("link")).toThrow("credential_file_unsafe");
    linkSync(file, join(root, "alias")); expect(() => directory.inspectFileIdentity("kizuki.db")).toThrow("credential_file_identity_changed");
  } finally { directory.close(); }
});

test.if(canExerciseCustody)("refuses forged, closed, cross-directory, unsafe-name, and pre-existing-file effects", () => {
  const one = temporary(), two = temporary(), first = openCredentialDirectory(one), second = openCredentialDirectory(two);
  try {
    expect(() => first.removeCreated({} as CredentialFileInspection, new Uint8Array())).toThrow("credential_file_handle");
    const created = first.create("credential"); expect(() => second.removeCreated(created, new Uint8Array())).toThrow("credential_file_handle");
    created.close(); expect(() => first.removeCreated(created, new Uint8Array())).toThrow("credential_file_handle");
    for (const name of ["", ".", "..", "a/b", "a\0b", "x".repeat(256)]) expect(() => first.inspect(name)).toThrow("credential_file_unsafe");
    writeFileSync(join(one, "existing"), "synthetic", { mode: 0o600 });
    expect(() => first.create("existing")).toThrow("credential_file_conflict"); expect(lstatSync(join(one, "existing")).isFile()).toBe(true);
    expect(readFileSync(join(one, "existing"), "utf8")).toBe("synthetic");
  } finally { first.close(); second.close(); }
});

test.if(canExerciseCustody)("creates exact mode despite a restrictive process umask", () => {
  const source = JSON.stringify(join(import.meta.dir, "../../src/agents/credential-file.ts"));
  const script = `
    import * as fs from "node:fs";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    const prior = process.umask(0o777);
    try {
      const { openCredentialDirectory } = await import(${source});
      const root = fs.mkdtempSync(join(tmpdir(), "kizuki-credential-umask-")); fs.chmodSync(root, 0o700);
      const directory = openCredentialDirectory(root), handle = directory.create("credential");
      try { if ((fs.statSync(join(root, "credential")).mode & 0o777) !== 0o600) process.exit(2); directory.removeCreated(handle, new Uint8Array()); }
      finally { directory.close(); fs.rmSync(root, { recursive: true, force: true }); }
    } finally { process.umask(prior); }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test.if(canExerciseCustody)("refuses symlink, hard-link, changed creation metadata, and parent replacement", () => {
  const root = temporary(), directory = openCredentialDirectory(root);
  try {
    symlinkSync(join(root, "missing"), join(root, "link")); expect(() => directory.inspect("link")).toThrow("credential_file_unsafe");
    const fifo = Bun.spawnSync(["mkfifo", join(root, "fifo")]); if (fifo.exitCode !== 0) throw new Error("fixture");
    expect(() => directory.inspect("fifo")).toThrow("credential_file_identity_changed");
    const held = directory.create("held"); held.close(); linkSync(join(root, "held"), join(root, "alias"));
    expect(() => directory.inspect("held")).toThrow("credential_file_identity_changed"); rmSync(join(root, "held")); rmSync(join(root, "alias"));
    const changed = directory.create("changed"); writeFileSync(join(root, "changed"), new Uint8Array([9]));
    expect(() => directory.writeComplete(changed, new Uint8Array([1]))).toThrow("credential_file_changed"); changed.close();
    const restored = directory.create("restored"), restoredPath = join(root, "restored");
    writeFileSync(restoredPath, new Uint8Array([9])); truncateSync(restoredPath, 0);
    const shifted = new Date(Date.now() + 10_000); utimesSync(restoredPath, shifted, shifted);
    expect(() => directory.writeComplete(restored, new Uint8Array([1]))).toThrow("credential_file_changed"); restored.close();
    const moved = `${root}-moved`; roots.push(moved); renameSync(root, moved); symlinkSync(moved, root);
    expect(() => directory.create("after-move")).toThrow(/credential_file_(identity_changed|unsafe)/);
  } finally { directory.close(); }
});

for (const mode of ["short", "zero", "throw", "fd-sync", "directory-sync"] as const) test.if(canExerciseCustody)(`handles ${mode} filesystem faults without a public fault flag`, () => {
  const source = JSON.stringify(join(import.meta.dir, "../../src/agents/credential-file.ts"));
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import { strict as assert } from "node:assert";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    const mode = ${JSON.stringify(mode)}, realWrite = fs.writeSync, realSync = fs.fsyncSync;
    let writes = 0, syncs = 0;
    mock.module("node:fs", () => ({ ...fs,
      writeSync(fd, bytes, offset, length, position) {
        writes++;
        if (mode === "throw") throw new Error("synthetic");
        if (mode === "zero") return 0;
        if (mode === "short" && writes === 1) return realWrite(fd, bytes, offset, 1, position);
        return realWrite(fd, bytes, offset, length, position);
      },
      fsyncSync(fd) {
        syncs++;
        if ((mode === "fd-sync" && syncs === 3) || (mode === "directory-sync" && syncs === 4)) throw new Error("synthetic");
        return realSync(fd);
      },
    }));
    const { openCredentialDirectory } = await import(${source});
    const root = fs.mkdtempSync(join(tmpdir(), "kizuki-credential-fault-")); fs.chmodSync(root, 0o700);
    const directory = openCredentialDirectory(root), handle = directory.create("credential"), bytes = new Uint8Array([1, 2, 3]);
    try {
      if (mode === "short") { directory.writeComplete(handle, bytes); directory.syncAndVerify(handle, bytes); directory.removeCreated(handle, bytes); }
      else { assert.throws(() => directory.writeComplete(handle, bytes), /credential_file_(write|unsafe)/);
        directory.removeCreated(handle, mode === "zero" || mode === "throw" ? new Uint8Array() : bytes); }
      assert.equal(fs.existsSync(join(root, "credential")), false);
    } finally { directory.close(); fs.rmSync(root, { recursive: true, force: true }); }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
