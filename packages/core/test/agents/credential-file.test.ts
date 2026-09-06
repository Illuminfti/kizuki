import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCredentialDirectory, type CredentialFileInspection } from "../../src/agents/credential-file";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "kizuki-credential-file-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function qualified(): boolean {
  const root = temporary();
  try {
    const directory = openCredentialDirectory(root);
    directory.close();
    return true;
  } catch { return false; }
}

const canExerciseCustody = qualified();

test("refuses an ancestry whose ownership cannot establish private custody", () => {
  const root = temporary();
  if (canExerciseCustody) return;
  expect(() => openCredentialDirectory(root)).toThrow("credential_file_unsafe");
  // The sandbox maps `/` and `/home` to uid 65534 while this process is uid
  // 1000, so refusing is the correct result and not a positive custody proof.
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("fixture");
  expect(statSync("/", { bigint: true }).uid).not.toBe(BigInt(uid));
});

test.if(canExerciseCustody)("creates an inert inode, durably verifies bytes, and cleans up only a held creation", () => {
  const root = temporary(), directory = openCredentialDirectory(root);
  try {
    const created = directory.create("credential");
    expect(created.identity.dev).toMatch(/^[0-9]+$/);
    expect(created.identity.ino).toMatch(/^[0-9]+$/);
    expect(created.bytes).toEqual(new Uint8Array());
    const token = new Uint8Array([7, 23, 91, 4]);
    directory.writeComplete(created, token);

    const inspected = directory.inspect("credential");
    expect(inspected).not.toBeNull();
    if (inspected === null) throw new Error("fixture");
    expect(inspected.bytes).toEqual(token);
    directory.syncAndVerify(inspected, token);
    expect(() => directory.removeCreated(inspected)).toThrow("credential_file_handle");
    const cleanup = directory.create("cleanup");
    directory.removeCreated(cleanup);
    expect(directory.inspect("cleanup")).toBeNull();
  } finally { directory.close(); }
});

test.if(canExerciseCustody)("rejects forged, cross-directory, symlink, hard-link, and mode-weakened handles", () => {
  const one = temporary(), two = temporary();
  const first = openCredentialDirectory(one), second = openCredentialDirectory(two);
  try {
    expect(() => first.syncAndVerify({} as CredentialFileInspection, new Uint8Array())).toThrow("credential_file_handle");
    const created = first.create("credential");
    expect(() => second.removeCreated(created)).toThrow("credential_file_handle");
    created.close();
    chmodSync(join(one, "credential"), 0o640);
    expect(() => first.inspect("credential")).toThrow("credential_file_identity_changed");
    rmSync(join(one, "credential"));
    symlinkSync(join(two, "missing"), join(one, "credential"));
    expect(() => first.inspect("credential")).toThrow("credential_file_unsafe");
    rmSync(join(one, "credential"));
    const held = first.create("held"); held.close();
    linkSync(join(one, "held"), join(one, "alias"));
    expect(() => first.inspect("held")).toThrow("credential_file_identity_changed");
  } finally { first.close(); second.close(); }
});

test.if(canExerciseCustody)("refuses a parent replacement before a file effect", () => {
  const container = temporary(), parent = join(container, "parent"), moved = join(container, "moved");
  mkdirSync(parent, { mode: 0o700 });
  const directory = openCredentialDirectory(parent);
  try {
    renameSync(parent, moved);
    symlinkSync(container, parent);
    expect(() => directory.create("credential")).toThrow(/credential_file_(identity_changed|unsafe)/);
  } finally { directory.close(); }
});
