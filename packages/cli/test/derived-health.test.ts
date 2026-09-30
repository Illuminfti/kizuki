import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { initVault, readDerivedMeta } from "@kizuki/core";
import { rebuildDerived } from "@kizuki/core/internal";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { refreshDerived } from "../src/derived";

test("an idle incremental pass repairs a skipped page restored to receipted bytes", async () => {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-index-health-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    await recordedPage(db, vault, "facts/tea.md", { id: "fact:tea", type: "fact", title: "Tea", status: "active", sensitivity: "public", taint: "clean" }, "Tea with [[Kettle]].");
    refreshDerived(db, vault);
    const path = join(vault, "facts/tea.md"), original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Tea with", "Changed tea with"));
    rebuildDerived(db, vault);
    expect(readDerivedMeta(db, "search")?.skipped_count).toBe(1);
    writeFileSync(path, original);
    const pass = refreshDerived(db, vault);
    expect(pass.remaining).toBe(0);
    for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(db, layer)).toMatchObject({ status: "ok", skipped_count: 0 });
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});
