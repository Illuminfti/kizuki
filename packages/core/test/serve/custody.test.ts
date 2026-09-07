import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { custodyNative } from "../../src/util/custody-native";
import { openCanonFiles } from "../../src/vault/canon-files";
import { initVault } from "../../src/vault/init";
import { doctorVault } from "../../src/vault/doctor";
import { serviceAncestorOwner, startServiceCustody } from "../../src/serve/custody";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "custody-inventory-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault);
  return { root, vault };
}

describe("service metadata custody composition", () => {
  test("an invocation string does not activate a capability outside the installed unit", async () => {
    const { vault } = fixture();
    const root = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      let failures = 0;
      await expect(startServiceCustody(vault, "synthetic-vault", { INVOCATION_ID: "1".repeat(32) },
        () => { failures += 1; })).rejects.toThrow("service_custody_unavailable");
      expect(serviceAncestorOwner(vault, root, fstatSync(root, { bigint: true }))).toBeUndefined();
      expect(serviceAncestorOwner(vault + "-other", root, fstatSync(root, { bigint: true }))).toBeUndefined();
      expect(failures).toBe(0);
      const files = openCanonFiles(vault);
      try { files.assertPrivateDirectory(".kizuki"); } finally { files.close(); }
    } finally { closeSync(root); }
  });

  test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "live and orphan invocation sockets are excluded from export/restore and doctor", () => {
      const { root, vault } = fixture(), control = join(vault, ".kizuki");
      const dir = openSync(control, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const names = [`custody-${"1".repeat(32)}.sock`, `custody-${"2".repeat(32)}.sock`];
      const api = custodyNative();
      const live = api.listen(dir, names[0]!);
      const orphan = api.listen(dir, names[1]!); closeSync(orphan);
      const db = openLedger(":memory:");
      try {
        const before = doctorVault(vault);
        const manifest = exportVault(db, vault, join(root, "backup"));
        expect(Object.keys(manifest.files).some(name => name.includes("custody-"))).toBe(false);
        restoreVault(join(root, "backup"), join(root, "restored"));
        expect(readdirSync(join(root, "restored", ".kizuki")).some(name => name.startsWith("custody-"))).toBe(false);
        expect(doctorVault(vault)).toEqual(before);
        const files = openCanonFiles(vault);
        try { files.assertPrivateDirectory(".kizuki"); } finally { files.close(); }
        for (const name of names) expect(existsSync(join(control, name))).toBe(true);
      } finally { db.close(); closeSync(live); closeSync(dir); }
    });
});
