import { afterEach, expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openOwnedDirectory, OwnedDirectoryPublicationError, type OwnedDirectoryIdentity } from "../../src/util/owned-directory";
import { loadOwnedDirectoryNative } from "../../src/util/owned-directory-native";

// Fixed private fixtures only: no concurrent pathname replacement or live vaults.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const path = mkdtempSync(join(tmpdir(), "kizuki-publication-")); roots.push(path); return path; }
function id(path: string): OwnedDirectoryIdentity { const stat = lstatSync(path, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; }
function failure(action: () => unknown): OwnedDirectoryPublicationError {
  try { action(); } catch (error) { expect(error).toBeInstanceOf(OwnedDirectoryPublicationError); return error as OwnedDirectoryPublicationError; }
  throw new Error("expected publication refusal");
}

test("fixed native flags return signed collision and nonempty errors while preserving both entries", () => {
  const path = root(), native = loadOwnedDirectoryNative();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    mkdirSync(join(path, "stage"), { mode: 0o700 }); mkdirSync(join(path, "destination"), { mode: 0o700 });
    writeFileSync(join(path, "destination", "kept"), "original");
    const stage = id(join(path, "stage")), destination = id(join(path, "destination"));
    const from = Buffer.from("stage\0"), to = Buffer.from("destination\0");
    expect(native.symbols.renameChildNoReplace(fd, ptr(from), fd, ptr(to))).toBe(-17);
    expect(native.symbols.removeEmptyChild(fd, ptr(to))).toBe(-39);
    expect(native.symbols.renameChildNoReplace(-1, ptr(from), -1, ptr(to))).toBe(-9);
    expect(id(join(path, "stage"))).toEqual(stage); expect(id(join(path, "destination"))).toEqual(destination);
    expect(readFileSync(join(path, "destination", "kept"), "utf8")).toBe("original");
  } finally { closeSync(fd); native.compiled.close(); native.libc.close(); }
});

test("exclusive staging returns its private inode and preserves an occupied name", () => {
  const path = root(), parent = openOwnedDirectory(path);
  try {
    const stage = parent.createStaging("stage");
    expect(stage).toEqual(id(join(path, "stage")));
    expect(lstatSync(join(path, "stage")).mode & 0o777).toBe(0o700);
    writeFileSync(join(path, "stage", "receipt"), "original");
    const error = failure(() => parent.createStaging("stage"));
    expect(error.reason).toBe("destination_exists"); expect(error.cleanup_safe).toBe(false);
    expect(readFileSync(join(path, "stage", "receipt"), "utf8")).toBe("original");
  } finally { parent.close(); }
});

for (const existing of [false, true]) test(`publication preserves staged data; empty destination=${existing}`, () => {
  const path = root(), parent = openOwnedDirectory(path);
  try {
    const stage = parent.createStaging("stage");
    writeFileSync(join(path, "stage", "receipt"), "complete");
    if (existing) mkdirSync(join(path, "destination"), { mode: 0o700 });
    const destination = existing ? id(join(path, "destination")) : null;
    expect(parent.publishStaging("stage", stage, "destination", destination)).toEqual({ publication: "published", durability: "synced" });
    expect(id(join(path, "destination"))).toEqual(stage);
    expect(readFileSync(join(path, "destination", "receipt"), "utf8")).toBe("complete");
    expect(readdirSync(path)).toEqual(["destination"]);
  } finally { parent.close(); }
});

test("sticky temp parent accepts root custody and refuses an unrelated owner", () => {
  const path = root(), parent = openOwnedDirectory(tmpdir());
  const name = `${basename(path)}-stage`, stagingPath = join(tmpdir(), name); roots.push(stagingPath);
  try {
    if (lstatSync(tmpdir()).uid !== 0) {
      expect(failure(() => parent.createStaging(name)).reason).toBe("unsafe");
      expect(existsSync(stagingPath)).toBe(false);
      return;
    }
    const stage = parent.createStaging(name);
    expect(parent.publishStaging(name, stage, basename(path), id(path)).publication).toBe("published");
    expect(id(path)).toEqual(stage); expect(existsSync(stagingPath)).toBe(false);
  } finally { parent.close(); }
});

for (const mode of ["occupied", "changed", "nonempty", "reservation"] as const) test(`fixed ${mode} destination is preserved on refusal`, () => {
  const path = root(), parent = openOwnedDirectory(path);
  try {
    const stage = parent.createStaging("stage"); writeFileSync(join(path, "stage", "receipt"), "staged");
    mkdirSync(join(path, "destination"), { mode: 0o700 });
    const original = id(join(path, "destination"));
    if (mode === "nonempty") writeFileSync(join(path, "destination", "kept"), "existing");
    const reserved = `.kizuki-empty-${original.dev.toString(16)}-${original.ino.toString(16)}-${stage.ino.toString(16)}`;
    if (mode === "reservation") writeFileSync(join(path, reserved), "reserved");
    const expected = mode === "occupied" ? null : mode === "changed" ? { ...original, ino: original.ino + 1n } : original;
    const error = failure(() => parent.publishStaging("stage", stage, "destination", expected));
    expect(error.reason).toBe(({ occupied: "destination_exists", changed: "destination_changed", nonempty: "destination_not_empty", reservation: "reservation_exists" } as const)[mode]);
    expect(error.publication).toBe("not_published");
    expect(error.cleanup_safe).toBe(mode === "occupied" || mode === "reservation");
    expect(id(join(path, "stage"))).toEqual(stage); expect(id(join(path, "destination"))).toEqual(original);
    expect(readFileSync(join(path, "stage", "receipt"), "utf8")).toBe("staged");
    if (mode === "nonempty") expect(readFileSync(join(path, "destination", "kept"), "utf8")).toBe("existing");
    if (mode === "reservation") expect(readFileSync(join(path, reserved), "utf8")).toBe("reserved");
  } finally { parent.close(); }
});

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0, overflow = false;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length <= 65_536) chunks.push(value); else overflow = true;
    }
  } finally { reader.releaseLock(); }
  return overflow ? "child_output_limit_exceeded" : Buffer.concat(chunks).toString("utf8");
}

test("invalid names, identities, permissions, and closed capabilities refuse before publication", () => {
  const path = root(), parent = openOwnedDirectory(path);
  try {
    const stage = parent.createStaging("stage");
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b", "\ud800", "x".repeat(256)]) {
      expect(failure(() => parent.publishStaging("stage", stage, name, null)).reason).toBe("invalid_name");
    }
    expect(failure(() => parent.publishStaging("stage", { dev: -1n, ino: 1n }, "destination", null)).reason).toBe("bounds");
    expect(failure(() => parent.publishStaging("stage", { ...stage, ino: stage.ino + 1n }, "destination", null)).reason).toBe("identity_changed");
    chmodSync(join(path, "stage"), 0o755);
    expect(failure(() => parent.publishStaging("stage", stage, "destination", null)).reason).toBe("unsafe");
    expect(readdirSync(path)).toEqual(["stage"]);
  } finally { parent.close(); }
  expect(failure(() => parent.createStaging("later")).reason).toBe("closed");
});

for (const mode of ["unsupported", "park-sync", "publish-refusal", "restore-refusal", "published-sync", "park-removal"])
  test(`fixed native or sync failure preserves recoverable data: ${mode}`, async () => {
    const path = root();
    const script = `
      import { strict as assert } from "node:assert";
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      import { join } from "node:path";
      const path = ${JSON.stringify(path)}, mode = ${JSON.stringify(mode)};
      const nativeModule = ${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))};
      const { loadOwnedDirectoryNative: realLoad } = await import(nativeModule);
      const realSync = fs.fsyncSync;
      let renames = 0, syncs = 0, armed = false;
      mock.module(nativeModule, () => ({ loadOwnedDirectoryNative() {
        const api = realLoad(), native = api.symbols;
        return { ...api, symbols: { ...native,
          renameChildNoReplace(...args) {
            renames++;
            if (mode === "unsupported") return -38;
            if ((mode === "publish-refusal" || mode === "restore-refusal") && renames === 2) return -17;
            if (mode === "restore-refusal" && renames === 3) return -17;
            return native.renameChildNoReplace(...args);
          },
          removeEmptyChild(...args) { return mode === "park-removal" ? -5 : native.removeEmptyChild(...args); },
        } };
      } }));
      mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
        if (armed) {
          syncs++;
          if ((mode === "park-sync" && syncs === 2) || (mode === "published-sync" && syncs === 4)) throw new Error("fixed sync refusal");
        }
        return realSync(fd);
      } }));
      const { openOwnedDirectory, OwnedDirectoryPublicationError } = await import(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory.ts"))});
      const parent = openOwnedDirectory(path);
      const stage = parent.createStaging("stage");
      fs.writeFileSync(join(path, "stage", "receipt"), "staged");
      fs.mkdirSync(join(path, "destination"), { mode: 0o700 });
      const before = fs.lstatSync(join(path, "destination"), { bigint: true });
      const original = { dev: before.dev, ino: before.ino };
      armed = true;
      let error;
      try { parent.publishStaging("stage", stage, "destination", original); } catch (caught) { error = caught; }
      assert.ok(error instanceof OwnedDirectoryPublicationError);
      if (mode === "published-sync" || mode === "park-removal") {
        assert.equal(error.publication, "published"); assert.equal(error.durability, "uncertain"); assert.equal(error.cleanup_safe, false);
        assert.equal(fs.readFileSync(join(path, "destination", "receipt"), "utf8"), "staged");
        assert.equal(fs.existsSync(join(path, "stage")), false);
        assert.ok(error.parked); assert.equal(fs.lstatSync(join(path, error.parked.name), { bigint: true }).ino, original.ino);
      } else if (mode === "restore-refusal") {
        assert.equal(error.cleanup_safe, false); assert.equal(error.durability, "uncertain");
        assert.ok(error.parked); assert.equal(fs.existsSync(join(path, "destination")), false);
        assert.equal(fs.lstatSync(join(path, error.parked.name), { bigint: true }).ino, original.ino);
        assert.equal(fs.readFileSync(join(path, "stage", "receipt"), "utf8"), "staged");
      } else {
        assert.equal(error.publication, "not_published"); assert.equal(error.cleanup_safe, true); assert.equal(error.parked, null);
        assert.equal(fs.lstatSync(join(path, "destination"), { bigint: true }).ino, original.ino);
        assert.equal(fs.readFileSync(join(path, "stage", "receipt"), "utf8"), "staged");
        assert.equal(error.reason, mode === "unsupported" ? "unsupported" : mode === "park-sync" ? "durability" : "destination_exists");
      }
      parent.close(); process.stdout.write("passed");
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, boundedText(child.stdout), boundedText(child.stderr)]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "passed", stderr: "" });
    } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; }
  }, 15_000);
