import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { initVault, readDerivedMeta } from "@kizuki/core";
import { rebuildDerived } from "@kizuki/core/internal";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { storedEvent } from "../../core/test/search/helpers";
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

test("incremental refresh reconciles an upgraded watermark with durable earlier coverage", () => {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-watermark-health-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    storedEvent(db, "before-upgrade");
    expect(refreshDerived(db, vault).remaining).toBe(0);
    expect(readDerivedMeta(db, "search")?.ledger_watermark).not.toBeNull();
    db.query("UPDATE derived_meta SET ledger_watermark=NULL WHERE layer='search'").run();
    const latest = storedEvent(db, "after-upgrade");
    const cursor = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(latest.event_id)!;
    expect(refreshDerived(db, vault)).toMatchObject({ events: 1, remaining: 0 });
    const watermark = `${cursor.accepted_at}\t${latest.event_id}`;
    expect(readDerivedMeta(db, "search")).toMatchObject({ status: "ok", ledger_watermark: watermark });
    expect(refreshDerived(db, vault)).toMatchObject({ events: 0, remaining: 0 });
    expect(readDerivedMeta(db, "search")?.ledger_watermark).toBe(watermark);
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});
