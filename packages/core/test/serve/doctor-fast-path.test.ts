import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { initVault } from "../../src/vault/init";
import { serializePage } from "../../src/vault/frontmatter";
import { listCanonPagesReport } from "../../src/vault/pages";
import { hashBytes } from "../../src/vault/write";
import { doctorVault } from "../../src/vault/doctor";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { derivedPageSkips } from "../../src/derived-health";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createFixtureVault() {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-doctor-fast-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  return { vault, db };
}

function addEvent(db: ReturnType<typeof openLedger>, id: string): string {
  const res = accept(db, {
    schema: "kizuki.event/v1",
    connector_id: "kizuki.import-legacy-events",
    source_record_id: id,
    kind: "note",
    occurred_at: "2026-10-01T00:00:00.000Z",
    observed_at: "2026-10-01T00:00:00.000Z",
    text: `synthetic event ${id}`,
    subjects: [],
    attachments: [],
    metadata: {},
    deleted: false,
  });
  if (res.status !== "stored") throw new Error("event not stored");
  return res.event.event_id;
}

function writeFixturePage(
  vault: string,
  relPath: string,
  id: string,
  sources: string[],
  status: "active" | "archived" = "active",
): string {
  mkdirSync(join(vault, "facts"), { recursive: true });
  const bytes = Buffer.from(
    serializePage({
      data: {
        id,
        title: `Title ${id}`,
        type: "fact",
        status,
        sensitivity: "personal",
        taint: "clean",
        sources,
      },
      body: `Synthetic body for ${id}.\n`,
    }),
    "utf8",
  );
  writeFileSync(join(vault, relPath), bytes, { mode: 0o600 });
  return hashBytes(bytes);
}

test("batched doctorVault and inspectServeDoctor match unbatched derivedPageSkips across mixed receipt and provenance states", () => {
  const { vault, db } = createFixtureVault();
  try {
    const evGood = addEvent(db, "good");
    const evUnreceipted = addEvent(db, "unreceipted");
    const evTombstoned = addEvent(db, "tombstoned");
    const evCorrupt = addEvent(db, "corrupt");

    // Tombstone evTombstoned so LIVE_PREDICATE excludes it.
    accept(db, {
      schema: "kizuki.event/v1",
      connector_id: "kizuki.import-legacy-events",
      source_record_id: "tombstoned",
      kind: "note",
      occurred_at: "2026-10-02T00:00:00.000Z",
      observed_at: "2026-10-02T00:00:00.000Z",
      text: "",
      subjects: [],
      attachments: [],
      metadata: {},
      deleted: true,
    });

    // Corrupt evCorrupt text directly (dropping trigger check not needed: text is mutable).
    db.query("UPDATE events SET text = 'tampered' WHERE event_id = ?").run(evCorrupt);

    const hGood = writeFixturePage(vault, "facts/good.md", "fact:good", [evGood]);
    writeFixturePage(vault, "facts/unreceipted.md", "fact:unreceipted", [evUnreceipted]);
    const hTomb = writeFixturePage(vault, "facts/tombstoned.md", "fact:tombstoned", [evTombstoned]);
    const hCorrupt = writeFixturePage(vault, "facts/corrupt.md", "fact:corrupt", [evCorrupt]);
    writeFixturePage(vault, "facts/missing-ev.md", "fact:missing", ["01JMISSING0000000000000000"]);
    writeFixturePage(vault, "facts/archived.md", "fact:archived", [], "archived");

    const insertReceipt = db.prepare(
      `INSERT INTO canon_receipts (
         receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
         before_hash, after_hash, at, receipt_kind, page_action, archive_path,
         writer, producer, model_ref, authority, confidence, taint,
         candidates, superseded, retrieval_ops, reverts, reverted_by
       ) VALUES (?, '[]', '[]', 'personal', ?, 'write', NULL, ?, '2026-10-01T00:00:00.000Z',
         'write', 'create', NULL, 'loop', 'model', NULL, 'model_inference', 0.7, 'clean',
         '[]', '[]', '[]', NULL, NULL)`,
    );
    insertReceipt.run("01JFAST0000000000000000001", "facts/good.md", hGood);
    insertReceipt.run("01JFAST0000000000000000002", "facts/tombstoned.md", hTomb);
    insertReceipt.run("01JFAST0000000000000000003", "facts/corrupt.md", hCorrupt);

    const liteReport = listCanonPagesReport(vault, undefined, undefined, {
      include_body: false,
      track_capacity: false,
    });
    const fullReport = listCanonPagesReport(vault);

    // doctorVault with prewalked report matches fresh doctorVault.
    expect(doctorVault(vault, db, liteReport)).toEqual(doctorVault(vault, db));
    expect(
      doctorVault(vault, db, liteReport).pages.find((p) => p.page === "facts/missing-ev.md")?.errors,
    ).toEqual(["sources: one or more event IDs do not resolve in the ledger"]);

    // inspectServeDoctor batched assessment must match unbatched derivedPageSkips identically.
    const expectedSkips = derivedPageSkips(db, fullReport);
    const serveFromLite = inspectServeDoctor(db, vault, { pages: liteReport });
    const serveFresh = inspectServeDoctor(db, vault);

    expect(serveFromLite.stores.skipped_pages).toEqual(expectedSkips);
    expect(serveFresh.stores.skipped_pages).toEqual(expectedSkips);
    expect(serveFromLite.stores.skipped_pages).toEqual([
      { path: "facts/corrupt.md", reason: "sources_unavailable" },
      { path: "facts/missing-ev.md", reason: "sources_unavailable" },
      { path: "facts/tombstoned.md", reason: "sources_unavailable" },
      { path: "facts/unreceipted.md", reason: "revision_unrecorded" },
    ]);
    expect(serveFromLite.canon).toEqual(serveFresh.canon);
    expect(serveFromLite.stores.origin).toEqual(serveFresh.stores.origin);
  } finally {
    db.close();
  }
});
