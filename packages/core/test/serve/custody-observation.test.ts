import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, rmSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeAncestorOwner } from "../../src/serve/custody-observation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "custody-observation-")); roots.push(path); chmodSync(path, 0o755);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  const observed = fstatSync(fd, { bigint: true });
  return { path, fd, observed };
}
function metadata(stat: BigIntStats) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, ctimeNs: stat.ctimeNs };
}

test("joins unchanged policy and RPC snapshots while permitting namespace owner translation", () => {
  const { fd, observed } = fixture();
  try { expect(observeAncestorOwner(fd, observed, () => ({ ...metadata(observed), uid: 0n, gid: 0n }))).toBe(0n); }
  finally { closeSync(fd); }
});

test("refuses actual chmod between the policy fstat and the RPC's new before snapshot", () => {
  const { path, fd, observed } = fixture();
  try {
    expect(() => observeAncestorOwner(fd, observed, () => {
      chmodSync(path, 0o777);
      return { ...metadata(fstatSync(fd, { bigint: true })), uid: 0n };
    })).toThrow("service_custody_changed");
  } finally { closeSync(fd); }
});

test("refuses actual chmod after the RPC snapshot before returning ownership credit", () => {
  const { path, fd, observed } = fixture();
  try {
    expect(() => observeAncestorOwner(fd, observed, () => {
      const reply = { ...metadata(fstatSync(fd, { bigint: true })), uid: 0n };
      chmodSync(path, 0o777);
      return reply;
    })).toThrow("service_custody_changed");
  } finally { closeSync(fd); }
});

for (const field of ["uid", "gid", "ctimeNs", "ino", "dev"] as const) {
  test(`refuses a ${field} policy snapshot different from the held descriptor`, () => {
    const { fd, observed } = fixture();
    try {
      const changed = Object.assign(Object.create(Object.getPrototypeOf(observed)), observed,
        { [field]: observed[field] + 1n }) as BigIntStats;
      expect(() => observeAncestorOwner(fd, changed, () => ({ ...metadata(changed), uid: 0n })))
        .toThrow("service_custody_changed");
    } finally { closeSync(fd); }
  });
}
