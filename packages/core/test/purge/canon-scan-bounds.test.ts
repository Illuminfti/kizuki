import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { PurgeError, previewPurge, purgeEvents } from "../../src/ledger/purge";
import { MAX_CANON_PAGES, listCanonPagesReport } from "../../src/vault/pages";
import { validEvent } from "../fixtures";
import { tempVault, writeCanon } from "../helpers/vault";

const fixtures: { dispose: () => void }[] = [];

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

function vault() {
  const db = openLedger(":memory:");
  const disk = tempVault("kizuki-purge-scan-bounds-");
  fixtures.push({
    dispose: () => {
      db.close();
      disk.dispose();
    },
  });
  return { db, vaultPath: disk.path };
}

/** Push the canon walk past MAX_CANON_PAGES so it reports a truncated scan. */
function overflowCanon(vaultPath: string, count: number): void {
  // "zz-filler" sorts after "people", so the real page is scanned first.
  const dir = join(vaultPath, "zz-filler");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, `page-${index}.md`), "filler\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

describe("purge against a canon scan that hit its page bound", () => {
  test("the walk reports truncation with a marker that is not a file", () => {
    const { vaultPath } = vault();
    overflowCanon(vaultPath, MAX_CANON_PAGES + 1);
    const report = listCanonPagesReport(vaultPath);
    expect(report.truncated).toBe(true);
    expect(report.skipped.some((row) => row.relPath === "." && row.code === "too_many")).toBe(
      true,
    );
  });

  test("preview refuses instead of opening the vault directory as a page", () => {
    const { db, vaultPath } = vault();
    const stored = accept(db, { ...validEvent(), source_record_id: "acme.md" });
    if (stored.status !== "stored") throw new Error("expected stored event");
    mkdirSync(join(vaultPath, "people"), { recursive: true, mode: 0o700 });
    writeCanon(
      vaultPath,
      "people/grace.md",
      {
        id: "page-grace",
        title: "grace",
        type: "person",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [stored.event.event_id],
      },
      "Grace runs partnerships at Acme.\n",
    );
    overflowCanon(vaultPath, MAX_CANON_PAGES);

    expect(() => previewPurge(db, vaultPath, { event_id: stored.event.event_id }, "cleanup"))
      .toThrow(PurgeError);
    try {
      previewPurge(db, vaultPath, { event_id: stored.event.event_id }, "cleanup");
    } catch (error) {
      expect(error).toMatchObject({ code: "canon_scan_truncated" });
    }
  });

  test("deletion refuses and keeps the event rather than purging a partial scan", () => {
    const { db, vaultPath } = vault();
    const stored = accept(db, { ...validEvent(), source_record_id: "acme.md" });
    if (stored.status !== "stored") throw new Error("expected stored event");
    overflowCanon(vaultPath, MAX_CANON_PAGES + 1);

    try {
      purgeEvents(db, vaultPath, { event_id: stored.event.event_id }, "cleanup");
      throw new Error("expected purge to refuse a truncated canon scan");
    } catch (error) {
      expect(error).toMatchObject({ code: "canon_scan_truncated" });
    }
    expect(
      db.query("SELECT event_id FROM events WHERE event_id = ?").get(stored.event.event_id),
    ).not.toBeNull();
  });
});
