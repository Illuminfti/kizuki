import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPurgeRewrite } from "../../src/canon/apply";
import { CanonAuthorityResolver } from "../../src/canon/authority";
import { snapshotCanonIo, withCanonMutationSync } from "../../src/canon/io";
import { undoReceipt } from "../../src/canon/undo";
import { correct } from "../../src/correction/correct";
import { exportVault, restoreVault, verifyBackup, V2_BACKUP_SCHEMA, type ExportManifest } from "../../src/export";
import { initAgents, OWNER } from "../../src/agents";
import { accept } from "../../src/ledger/ledger";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import {
  LINEAGE_UNAVAILABLE_WARNING,
  SOURCE_SURVIVOR_LINEAGE_BACKUP,
  getSourceSurvivorLineage,
  lineageRowCount,
} from "../../src/ledger/canon-source-survivor-lineage";
import { registerConnection } from "../../src/ledger/connections";
import { resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { serveGetPage } from "../../src/serving/page";
import { initVault } from "../../src/vault/init";
import { assessLivePageEvidence } from "../../src/vault/provenance";
import { listCanonPages } from "../../src/vault/pages";
import { validEvent } from "../fixtures";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { storeClaim, write } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function policy() {
  return {
    purposes: ["capture", "recall", "session", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked" as const,
    egress: "local_only" as const,
    sensitivity_floor: "private" as const,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "source-survivor-"));
  dirs.push(dir);
  initVault(dir);
  const db = openLedger(join(dir, ".kizuki", "kizuki.db"));
  const a = ulid();
  const b = ulid();
  const c = ulid();
  registerConnection(db, "kizuki.fixture", a);
  registerConnection(db, "kizuki.fixture", b);
  registerConnection(db, "kizuki.fixture", c);
  return { dir, db, a, b, c };
}

function grant(db: ReturnType<typeof openLedger>, key: string, operation: string) {
  return setSourceGrant(db, {
    source_key: key,
    expected_revision: 0,
    operation_id: operation,
    policy: policy(),
  });
}

function event(sourceRecord: string, text: string) {
  return { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: sourceRecord, text };
}

function acceptSource(db: ReturnType<typeof openLedger>, key: string, sourceRecord: string, text: string) {
  const stored = accept(db, event(sourceRecord, text), { source: { source_key: key, expected_revision: 1 } });
  if (stored.status !== "stored") throw new Error("fixture failed");
  return stored.event;
}

const retrieval = { ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) } };

function signManifest(backup: string, manifest: ExportManifest): void {
  const files: Record<string, ExportManifest["files"][string]> = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key]!;
  const unsigned = {
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files,
  };
  const signed = {
    ...unsigned,
    manifest_sha256: new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex"),
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`);
  chmodSync(join(backup, "manifest.json"), 0o600);
}

test("source survivor checkpoint admits retained B with a different result tier", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    initAgents(db);
    const aa = acceptSource(db, a, "a", "A_ONLY_LINEAGE");
    const bb = acceptSource(db, b, "b", "B independent survivor");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY_LINEAGE",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, bb.event_id, {
      kind: "merge",
      predicate: null,
      object: null,
      body: "B independent survivor",
      frontmatter: { type: "person", title: "Shared" },
    }));
    await correct(io, { statement: "B independent survivor remains owner-corrected.", target: { claim_id: original.claim_ids[0] } });
    const before = new CanonAuthorityResolver(db, [original.page_path]).basis(
      original.page_path,
      listCanonPages(dir).find(page => page.relPath === original.page_path)!.contentHash,
    );
    expect(before?.authority).toBe("owner_correction");
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-a" });
    const done = await resumeSourceRevocation(db, dir, "erase-a", retrieval);
    expect(done.status).toBe("purged");
    const page = listCanonPages(dir).find(row => row.relPath === original.page_path)!;
    const evidence = assessLivePageEvidence(db, page);
    expect(evidence.admitted).toBe(true);
    if (!evidence.admitted) throw new Error("expected admitted survivor");
    const lineage = getSourceSurvivorLineage(db, evidence.revision.receipt_id);
    expect(lineage).not.toBeNull();
    expect(lineage?.predecessor_effective_authority).toBe("owner_correction");
    expect(lineage?.result_authority).toBe("connector_evidence");
    expect(evidence.revision.authority).toBe("connector_evidence");
    expect(serveGetPage({ db, vaultPath: dir, principal: OWNER }, { path: original.page_path }).canon).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("repeated source erasure links checkpoints without restoring erased preimages", async () => {
  const { db, dir, a, b, c } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    grant(db, c, "grant-c");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    const bb = acceptSource(db, b, "b", "B_ONLY");
    const cc = acceptSource(db, c, "c", "C_ONLY");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, bb.event_id, {
      kind: "merge", predicate: null, object: null, body: "B_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, cc.event_id, {
      kind: "merge", predicate: null, object: null, body: "C_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-a" });
    expect((await resumeSourceRevocation(db, dir, "erase-a", retrieval)).status).toBe("purged");
    const first = getSourceSurvivorLineage(db, db.query<{ receipt_id: string }, [string]>(
      "SELECT receipt_id FROM canon_receipts WHERE page_path=? AND receipt_kind='purge_rewrite' ORDER BY at DESC, receipt_id DESC LIMIT 1",
    ).get(original.page_path)!.receipt_id);
    expect(first).not.toBeNull();
    revokeSourceGrant(db, { source_key: b, expected_revision: 1, operation_id: "erase-b" });
    expect((await resumeSourceRevocation(db, dir, "erase-b", retrieval)).status).toBe("purged");
    expect(lineageRowCount(db)).toBe(2);
    const page = listCanonPages(dir).find(row => row.relPath === original.page_path)!;
    expect(page.body).toContain("C_ONLY");
    expect(page.body).not.toContain("A_ONLY");
    expect(page.body).not.toContain("B_ONLY");
    const evidence = assessLivePageEvidence(db, page);
    expect(evidence.admitted).toBe(true);
    if (!evidence.admitted) throw new Error("expected admitted survivor");
    const second = getSourceSurvivorLineage(db, evidence.revision.receipt_id);
    expect(second?.predecessor_receipt_id).toBe(first?.child_receipt_id);
    expect(existsSync(join(dir, original.page_path))).toBe(true);
  } finally {
    db.close();
  }
});

test("ordinary purge, revert and undo-of-undo reach a source-survivor checkpoint", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    const bb = acceptSource(db, b, "b", "B survivor marker");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    const merged = write(io, await storeClaim(db, bb.event_id, {
      kind: "merge", predicate: null, object: null, body: "B survivor marker",
      frontmatter: { type: "person", title: "Shared" },
    }));
    const edited = write(io, await storeClaim(db, bb.event_id, {
      kind: "edit", predicate: null, object: null, body: "B survivor marker",
      frontmatter: { type: "person", title: "Shared" },
    }));
    const reverted = await undoReceipt(io, edited.receipt_id);
    expect(reverted.kind).toBe("revert");
    const restored = await undoReceipt(io, reverted.receipt_id);
    expect(restored.kind).toBe("revert");
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-a" });
    expect((await resumeSourceRevocation(db, dir, "erase-a", retrieval)).status).toBe("purged");
    const page = listCanonPages(dir).find(row => row.relPath === original.page_path)!;
    expect(assessLivePageEvidence(db, page).admitted).toBe(true);
    const purged = withCanonMutationSync(snapshotCanonIo(io), (scope, bound) => applyPurgeRewrite(scope, bound, {
      rel_path: original.page_path,
      purged_event_ids: [],
      purged_claim_ids: [],
      purged_claim_bodies: ["unused fragment"],
    }));
    expect(purged.kind).toBe("purge_rewrite");
    expect(getSourceSurvivorLineage(db, purged.receipt_id)).toBeNull();
    const after = listCanonPages(dir).find(row => row.relPath === original.page_path)!;
    const evidence = assessLivePageEvidence(db, after);
    expect(evidence.admitted).toBe(true);
    expect(lineageRowCount(db)).toBe(1);
    expect(evidence.admitted && evidence.revision.authority).toBe("connector_evidence");
    expect(merged.after_hash).not.toBe(after.contentHash);
  } finally {
    db.close();
  }
});

test("source erasure refuses a page with no positive preimage and does not invent a checkpoint", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    acceptSource(db, b, "b", "B independent");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    writeFileSync(join(dir, original.page_path), `${readFileSync(join(dir, original.page_path), "utf8")}\nOwner hand edit.\n`);
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-unrecorded" });
    const pending = await resumeSourceRevocation(db, dir, "erase-unrecorded", retrieval);
    expect(pending.status).toBe("denied");
    expect(lineageRowCount(db)).toBe(0);
    expect(assessLivePageEvidence(db, listCanonPages(dir).find(row => row.relPath === original.page_path)!).admitted).toBe(false);
  } finally {
    db.close();
  }
});

test("interrupted lineage commit retries the original checkpoint and refuses a synthesized replacement", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    const bb = acceptSource(db, b, "b", "B survivor marker");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, bb.event_id, {
      kind: "merge", predicate: null, object: null, body: "B survivor marker",
      frontmatter: { type: "person", title: "Shared" },
    }));
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-interrupt" });
    db.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON canon_source_survivor_lineage BEGIN SELECT RAISE(FAIL,'synthetic lineage interruption'); END");
    const pending = await resumeSourceRevocation(db, dir, "erase-interrupt", retrieval);
    expect(pending.status).toBe("denied");
    expect(lineageRowCount(db)).toBe(0);
    expect(db.query("SELECT 1 FROM canon_source_erasure_intents LIMIT 1").get()).not.toBeNull();
    const intent = JSON.parse(db.query<{ intent: string }, []>("SELECT intent FROM canon_source_erasure_intents").get()!.intent) as {
      version: number;
      lineage: { child_receipt_id: string; after_hash: string } | null;
      receipt: { after_hash: string; page_path: string };
    };
    expect(intent.version).toBe(2);
    expect(intent.lineage?.after_hash).toBe(intent.receipt.after_hash);
    db.exec("DROP TRIGGER fail_lineage");
    db.close();
    const reopened = openLedger(join(dir, ".kizuki", "kizuki.db"));
    try {
      const done = await resumeSourceRevocation(reopened, dir, "erase-interrupt", retrieval);
      expect(done.status).toBe("purged");
      expect(lineageRowCount(reopened)).toBe(1);
      const page = listCanonPages(dir).find(row => row.relPath === original.page_path)!;
      expect(assessLivePageEvidence(reopened, page).admitted).toBe(true);
      expect(getSourceSurvivorLineage(reopened, intent.lineage!.child_receipt_id)?.after_hash).toBe(intent.lineage!.after_hash);
    } finally {
      reopened.close();
    }
  } finally {
    try { db.close(); } catch { /* already closed after the reopen path */ }
  }
});

test("a legacy live-survivor postimage without a checkpoint stays incomplete and withheld", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    const bb = acceptSource(db, b, "b", "B survivor marker");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, bb.event_id, {
      kind: "merge", predicate: null, object: null, body: "B survivor marker",
      frontmatter: { type: "person", title: "Shared" },
    }));
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-legacy" });
    db.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON canon_source_survivor_lineage BEGIN SELECT RAISE(FAIL,'synthetic lineage interruption'); END");
    const pending = await resumeSourceRevocation(db, dir, "erase-legacy", retrieval);
    expect(pending.status).toBe("denied");
    const row = db.query<{ intent: string }, []>("SELECT intent FROM canon_source_erasure_intents").get();
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row!.intent) as Record<string, unknown>;
    delete parsed["lineage"];
    parsed["version"] = 1;
    const json = JSON.stringify(parsed);
    db.query("UPDATE canon_source_erasure_intents SET intent=?,digest=?").run(json, sha256Hex(json));
    db.exec("DROP TRIGGER fail_lineage");
    const again = await resumeSourceRevocation(db, dir, "erase-legacy", retrieval);
    expect(again.status).toBe("denied");
    expect(lineageRowCount(db)).toBe(0);
    const page = listCanonPages(dir).find(row => row.relPath === original.page_path);
    expect(page === undefined || assessLivePageEvidence(db, page).admitted).toBe(false);
  } finally {
    db.close();
  }
});

test("export round-trips lineage and refuses a current backup that omits the required stream", async () => {
  const { db, dir, a, b } = setup();
  try {
    grant(db, a, "grant-a");
    grant(db, b, "grant-b");
    const aa = acceptSource(db, a, "a", "A_ONLY");
    const bb = acceptSource(db, b, "b", "B survivor marker");
    const io = { db, vault_path: dir };
    const original = write(io, await storeClaim(db, aa.event_id, {
      body: "A_ONLY",
      frontmatter: { type: "person", title: "Shared" },
    }));
    write(io, await storeClaim(db, bb.event_id, {
      kind: "merge", predicate: null, object: null, body: "B survivor marker",
      frontmatter: { type: "person", title: "Shared" },
    }));
    revokeSourceGrant(db, { source_key: a, expected_revision: 1, operation_id: "erase-a" });
    expect((await resumeSourceRevocation(db, dir, "erase-a", retrieval)).status).toBe("purged");
    const backup = join(dir, "backup");
    const manifest = exportVault(db, dir, backup);
    expect(manifest.schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    expect(manifest.files[SOURCE_SURVIVOR_LINEAGE_BACKUP]?.count).toBe(1);
    const restoredDir = join(dir, "restored");
    restoreVault(backup, restoredDir);
    const restored = openLedger(join(restoredDir, ".kizuki", "kizuki.db"));
    try {
      expect(lineageRowCount(restored)).toBe(1);
      const page = listCanonPages(restoredDir).find(row => row.relPath === original.page_path)!;
      expect(assessLivePageEvidence(restored, page).admitted).toBe(true);
    } finally {
      restored.close();
    }
    const missing = join(dir, "missing");
    const missingManifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
    unlinkSync(join(backup, SOURCE_SURVIVOR_LINEAGE_BACKUP));
    delete missingManifest.files[SOURCE_SURVIVOR_LINEAGE_BACKUP];
    signManifest(backup, missingManifest);
    expect(() => verifyBackup(backup)).toThrow(/source-survivor lineage stream is missing/);
    expect(() => restoreVault(backup, missing)).toThrow(/source-survivor lineage stream is missing/);
    expect(existsSync(missing)).toBe(false);
  } finally {
    db.close();
  }
});

test("a legacy-format backup carrying lineage is refused before publication", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a, "grant-a");
    acceptSource(db, a, "a", "plain event");
    const backup = join(dir, "backup");
    const manifest = exportVault(db, dir, backup);
    manifest.schema = V2_BACKUP_SCHEMA;
    signManifest(backup, manifest);
    expect(() => verifyBackup(backup)).toThrow(/must not include source-survivor lineage/);
    expect(() => restoreVault(backup, join(dir, "restored"))).toThrow(/must not include source-survivor lineage/);
    expect(existsSync(join(dir, "restored"))).toBe(false);
  } finally {
    db.close();
  }
});

test("supported backups without the stream restore without inventing checkpoints", async () => {
  const { db, dir, a } = setup();
  try {
    grant(db, a, "grant-a");
    acceptSource(db, a, "a", "plain event");
    const backup = join(dir, "backup");
    const manifest = exportVault(db, dir, backup);
    unlinkSync(join(backup, SOURCE_SURVIVOR_LINEAGE_BACKUP));
    delete manifest.files[SOURCE_SURVIVOR_LINEAGE_BACKUP];
    manifest.schema_versions = { ...manifest.schema_versions, ledger: 19 };
    signManifest(backup, manifest);
    const restoredDir = join(dir, "restored");
    const report = restoreVault(backup, restoredDir);
    expect(report.recovery_warnings).toContain(LINEAGE_UNAVAILABLE_WARNING);
    const restored = openLedger(join(restoredDir, ".kizuki", "kizuki.db"));
    try {
      expect(lineageRowCount(restored)).toBe(0);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
  }
});
