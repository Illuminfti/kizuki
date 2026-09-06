import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SCHEMA,
  exportVault,
  restoreVault,
  verifyBackup,
  type ExportManifest,
  type ExportManifestEntry,
} from "../src/export";
import { readRailCursor, writeRailCursor } from "../src/ledger/checkpoints";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { revokeSourceGrant, resumeSourceRevocation, setSourceGrant } from "../src/ledger/source-grants";
import { purgeEvents } from "../src/ledger/purge";
import { listSubjectAliases } from "../src/claims/identity";
import { fileProposal } from "../src/staging/proposals";
import { readVaultId } from "../src/serve/vault-id";
import { serializePage } from "../src/vault/frontmatter";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";

const directories: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function populated() {
  const db = openLedger(":memory:");
  const vaultPath = temporary("kizuki-export-vault-");
  initVault(vaultPath);

  const first = accept(db, validEvent());
  const second = accept(db, { ...validEvent(), source_record_id: "rec-2" });
  if (first.status !== "stored" || second.status !== "stored") {
    throw new Error("expected stored events");
  }
  purgeEvents(db, vaultPath, { event_id: first.event.event_id }, "source erased");

  const sourceKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  db.query(
    `INSERT INTO connections
       (connector_id, source_key, config, secret_refs, connected_at, disconnected_at,
        implementation_version)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    "fixture",
    sourceKey,
    '{"schema":"kizuki.connection-config/v1","state_ref_index":null}',
    "[]",
    new Date().toISOString(),
    "fixture@1",
  );
  // Seed an archived checkpoint/run snapshot for read and round-trip tests.
  const checkpointAt = new Date().toISOString();
  const checkpointResult = {
    stored: 1,
    duplicates: 0,
    errors: [],
    proposals_created: 1,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: "next",
  };
  db.query(`INSERT INTO checkpoints
    (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result)
    VALUES ('fixture', ?, ?, 'sync', ?, ?, ?)`)
    .run(sourceKey, "next", checkpointAt, checkpointAt, JSON.stringify(checkpointResult));
  db.query(`INSERT INTO connection_runs
    (run_id, connector_id, source_key, mode, started_at, finished_at,
     previous_cursor, attempted_cursor, committed_cursor, stored, duplicates, errors, status)
    VALUES (?, 'fixture', ?, 'sync', ?, ?, NULL, ?, ?, ?, 0, '[]', 'ok')`)
    .run(sourceKey, sourceKey, checkpointAt, checkpointAt, "next", "next", checkpointResult.stored);
  writeFileSync(join(vaultPath, "notes.txt"), "plain vault file\n");
  writeFileSync(join(vaultPath, "z-last.txt"), "z\n");
  writeFileSync(join(vaultPath, "ä-umlaut.txt"), "ae\n");
  mkdirSync(join(vaultPath, "people"), { recursive: true });
  writeFileSync(
    join(vaultPath, "people", "Ada.md"),
    serializePage({
      data: {
        id: "ada",
        title: "Ada",
        type: "person",
        status: "active",
        sensitivity: "public",
        taint: "clean",
      },
      body: "",
    }),
  );
  writeFileSync(join(vaultPath, ".kizuki", "private-state"), "excluded\n");
  return { db, vaultPath, remainingEventId: second.event.event_id, sourceKey };
}

function insertFixtureClaim(
  db: ReturnType<typeof openLedger>,
  body: string,
  claimId = "01EXPORTCLAIM00000000000001",
): void {
  const at = "2026-01-01T00:00:00.000Z";
  db.query(
    `INSERT INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    claimId,
    "claim",
    "people/ada",
    body,
    "{}",
    "[]",
    '["person:ada"]',
    "deterministic",
    0.9,
    "live",
    at,
    "bodyhash",
    "person:ada",
    "employment.works_at",
    "acme",
    "positive",
    "person:ada|employment.works_at",
    "connector_evidence",
    "personal",
    "quoted",
    null,
    at,
    null,
    at,
    null,
    null,
    null,
    1,
    null,
  );
}

function fileSplitSignatures(
  db: ReturnType<typeof openLedger>,
  eventId: string,
) {
  const shared = {
    kind: "claim" as const,
    target: "facts/same-body",
    body: "same body",
    provenance: [eventId],
    subjects: ["person:ada"],
    producer: "deterministic" as const,
    confidence: 1,
  };
  const first = fileProposal(db, {
    ...shared,
    frontmatter: { type: "fact", title: "one" },
  });
  const second = fileProposal(db, {
    ...shared,
    frontmatter: { type: "fact", title: "two" },
  });
  if (first.outcome !== "stored" || second.outcome !== "stored") {
    throw new Error("expected two stored split-signature claims");
  }
  return { first: first.proposal, second: second.proposal, shared };
}

function liveSplitSignatures(db: ReturnType<typeof openLedger>) {
  return db
    .query<{ claim_id: string; content_hash: string }, []>(
      `SELECT claim_id, content_hash FROM claims
        WHERE target = 'facts/same-body' AND status = 'live'
        ORDER BY created_at, claim_id`,
    )
    .all();
}

function rewriteClaimsJsonl(
  backup: string,
  manifest: ExportManifest,
  rewrite: (row: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = join(backup, "claims", "claims.jsonl");
  const rewritten = `${readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.stringify(rewrite(JSON.parse(line) as Record<string, unknown>)))
    .join("\n")}\n`;
  const payload = Buffer.from(rewritten);
  writeFileSync(path, payload);
  chmodSync(path, 0o600);
  const key = "claims/claims.jsonl";
  const previous = manifest.files[key];
  if (previous === undefined) throw new Error("expected claims/claims.jsonl");
  writeSignedManifest(backup, {
    ...manifest,
    files: {
      ...manifest.files,
      [key]: {
        count: previous.count,
        size: payload.byteLength,
        mode: 0o600,
        sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
      },
    },
  });
}

function grantExport(db: ReturnType<typeof openLedger>, sourceKey: string): void {
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: `export-grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "recall", "session", "derive", "extract", "export"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
}

function erasureReport(hashes: unknown = []): string {
  return JSON.stringify({
    logical_absence: true,
    owned_file_maintenance: "complete",
    external_copies: "out_of_scope",
    affected_claim_ids: [],
    affected_proposal_ids: [],
    affected_receipt_ids: [],
    affected_identity_hashes: hashes,
    retained_reasons: [],
  });
}

function writeSignedManifest(
  backup: string,
  manifest: Omit<ExportManifest, "manifest_sha256">,
): ExportManifest {
  const files: Record<string, ExportManifestEntry> = {};
  for (const key of Object.keys(manifest.files).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const entry = manifest.files[key];
    if (entry !== undefined) files[key] = entry;
  }
  const unsigned = {
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files,
  };
  const signed: ExportManifest = {
    ...unsigned,
    manifest_sha256: new Bun.CryptoHasher("sha256")
      .update(`${JSON.stringify(unsigned, null, 2)}\n`)
      .digest("hex"),
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`);
  chmodSync(join(backup, "manifest.json"), 0o600);
  return signed;
}

function legacyFiles(backup: string, current: Record<string, ExportManifestEntry>): Record<string, ExportManifestEntry> {
  const files = { ...current };
  for (const table of ["purge_batches", "purge_batch_receipts", "purge_ops"]) {
    delete files[`ledger/${table}.jsonl`];
    rmSync(join(backup, "ledger", `${table}.jsonl`));
  }
  return files;
}

function insertFixtureReceipt(
  db: ReturnType<typeof openLedger>,
  kind = "purge_review",
): void {
  db.query(
    `INSERT INTO canon_receipts
       (receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
        before_hash, after_hash, at, receipt_kind, page_action, archive_path,
        writer, producer, model_ref, authority, confidence, taint,
        candidates, superseded, retrieval_ops, reverts, reverted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "01EXPORTRECEIPTKIND000000001",
    "[]",
    "[]",
    "personal",
    "people/Ada.md",
    kind,
    null,
    "a".repeat(64),
    "2026-01-01T00:00:00.000Z",
    "write",
    "edit",
    null,
    "loop",
    "deterministic",
    null,
    "connector_evidence",
    1,
    "quoted",
    "[]",
    "[]",
    "[]",
    null,
    null,
  );
}

function utf8BodyOnChunkBoundary(): string {
  const empty = JSON.stringify({
    schema: "kizuki.claim/v1",
    claim_id: "01EXPORTUTF8CLAIM0000000001",
    kind: "claim",
    target: "people/ada",
    body: "",
    frontmatter: {},
    provenance: [],
    subjects: ["person:ada"],
    producer: "deterministic",
    confidence: 0.9,
    status: "live",
    created_at: "2026-01-01T00:00:00.000Z",
    body_hash: "bodyhash",
    subject: "person:ada",
    predicate: "employment.works_at",
    object: "acme",
    polarity: "positive",
    claim_key: "person:ada|employment.works_at",
    authority: "connector_evidence",
    sensitivity: "personal",
    taint: "quoted",
    model_ref: null,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    asserted_at: "2026-01-01T00:00:00.000Z",
    retracted_at: null,
    superseded_by: null,
    receipt_id: null,
    corroboration: 1,
    last_confirmed_at: null,
  });
  const prefix = empty.indexOf('"body":"') + '"body":"'.length;
  const pad = 65_535 - Buffer.byteLength(empty.slice(0, prefix));
  if (pad < 1) throw new Error("chunk-boundary pad is not positive");
  return `${"a".repeat(pad)}中`;
}

describe("exportVault", () => {
  test("writes a complete kizuki.backup/v3 manifest with matching hashes", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);

    expect(manifest.schema).toBe(BACKUP_SCHEMA);
    expect(manifest.complete).toBe(true);
    expect(manifest.schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    expect(manifest.files["ledger/events.jsonl"]?.count).toBe(1);
    expect(manifest.files["ledger/canon-machine-byte-intents.jsonl"]?.count).toBe(0);
    expect(manifest.files["ledger/event_purges.jsonl"]?.count).toBe(1);
    expect(manifest.files["connections.jsonl"]?.count).toBe(1);
    expect(manifest.files["checkpoints.jsonl"]?.count).toBe(1);
    expect(manifest.files["rail_cursors.jsonl"]?.count).toBe(0);
    expect(manifest.snapshot.event_count).toBe(1);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toEqual(
      manifest,
    );
    expect(verifyBackup(outDir).manifest_sha256).toBe(manifest.manifest_sha256);
    for (const [path, entry] of Object.entries(manifest.files)) {
      expect(
        new Bun.CryptoHasher("sha256")
          .update(readFileSync(join(outDir, path)))
          .digest("hex"),
      ).toBe(entry.sha256);
      expect(lstatSync(join(outDir, path)).mode & 0o777).toBe(0o600);
    }
    expect(lstatSync(outDir).mode & 0o777).toBe(0o700);
    db.close();
  });

  test("round-trips extract rail cursors without putting them in checkpoints", () => {
    const { db, vaultPath } = populated();
    writeRailCursor(db, "kizuki.producer.model", "extract", "2026-01-01T00:00:00Z\t01ARZ3NDEKTSV4RRFFQ69G5FAV");
    writeRailCursor(db, "kizuki.producer.model", "extract-deferred-scan", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    expect(manifest.files["rail_cursors.jsonl"]?.count).toBe(2);
    const rails = readFileSync(join(backup, "rail_cursors.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rails).toEqual([
      {
        rail: "kizuki.producer.model",
        source_key: "extract",
        cursor: "2026-01-01T00:00:00Z\t01ARZ3NDEKTSV4RRFFQ69G5FAV",
        updated_at: expect.any(String),
      },
      {
        rail: "kizuki.producer.model",
        source_key: "extract-deferred-scan",
        cursor: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        updated_at: expect.any(String),
      },
    ]);
    expect(readFileSync(join(backup, "checkpoints.jsonl"), "utf8")).not.toContain(
      "kizuki.producer.model",
    );
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(readRailCursor(restored, "kizuki.producer.model", "extract")).toBe(
      "2026-01-01T00:00:00Z\t01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(readRailCursor(restored, "kizuki.producer.model", "extract-deferred-scan")).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    restored.close();
    db.close();
  });

  test("copies classified canon but excludes unrelated files and the control directory", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, outDir);
    expect(existsSync(join(outDir, "vault", "notes.txt"))).toBe(false);
    expect(readFileSync(join(outDir, "vault", "people", "Ada.md"), "utf8")).toContain("Ada");
    expect(existsSync(join(outDir, "vault", ".kizuki"))).toBe(false);
    const connections = readFileSync(join(outDir, "connections.jsonl"), "utf8");
    expect(connections).not.toContain("resolved_secret");
    expect(connections).toContain("fixture@1");
    db.close();
  });

  test("orders vault files by Unicode code unit, not locale", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);
    const vaultKeys = Object.keys(manifest.files).filter((key) =>
      key.startsWith("vault/"),
    );
    expect(vaultKeys).toEqual([...vaultKeys].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ));
    expect(vaultKeys).not.toContain("vault/z-last.txt");
    expect(vaultKeys).not.toContain("vault/ä-umlaut.txt");
    db.close();
  });

  test("refuses a non-empty output directory without changing it", () => {
    const { db, vaultPath } = populated();
    const outDir = temporary("kizuki-export-nonempty-");
    const marker = join(outDir, "keep.txt");
    writeFileSync(marker, "keep\n");
    expect(() => exportVault(db, vaultPath, outDir)).toThrow(/not empty/);
    expect(readFileSync(marker, "utf8")).toBe("keep\n");
    db.close();
  });

  test("does not delete another run's incomplete staging", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    const other = join(parent, `other${".kizuki-backup-"}01OTHERSTAGING0000000001.partial`);
    mkdirSync(other);
    writeFileSync(join(other, ".kizuki-backup-incomplete"), "incomplete\n");
    exportVault(db, vaultPath, join(parent, "dump"));
    expect(readFileSync(join(other, ".kizuki-backup-incomplete"), "utf8")).toBe(
      "incomplete\n",
    );
    db.close();
  });

  test("does not recursively delete a destination that filled during export", () => {
    const { db, vaultPath } = populated();
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    expect(() =>
      exportVault(db, vaultPath, outDir, {
        onProgress: (label) => {
          if (label === "vault" && !existsSync(outDir)) {
            mkdirSync(outDir);
            writeFileSync(join(outDir, "keep.txt"), "keep\n");
          }
        },
      }),
    ).toThrow(/not empty/);
    expect(readFileSync(join(outDir, "keep.txt"), "utf8")).toBe("keep\n");
    db.close();
  });

  test("removes the staging directory when export is cancelled", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    const outDir = join(parent, "dump");
    expect(() =>
      exportVault(db, vaultPath, outDir, {
        onProgress: (label) => {
          if (label === "vault") throw new Error("injected failure");
        },
      }),
    ).toThrow(/injected failure/);
    expect(existsSync(outDir)).toBe(false);
    expect(
      readdirSync(parent).some((name) => name.includes(".kizuki-backup-")),
    ).toBe(false);
    db.close();
  });

  test("removes the staging directory when export setup fails", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    const outDir = join(parent, "dump");
    expect(() =>
      exportVault(db, vaultPath, outDir, {
        onProgress: (label) => {
          if (label === "staging") throw new Error("injected staging failure");
        },
      }),
    ).toThrow(/injected staging failure/);
    expect(existsSync(outDir)).toBe(false);
    expect(
      readdirSync(parent).some((name) => name.includes(".kizuki-backup-")),
    ).toBe(false);
    db.close();
  });

  test("refuses a destination inside the vault, including through a symlink", () => {
    const { db, vaultPath } = populated();
    expect(() => exportVault(db, vaultPath, join(vaultPath, "inside"))).toThrow(
      /must not be inside the vault/,
    );
    const parent = temporary("kizuki-export-alias-");
    const alias = join(parent, "alias");
    symlinkSync(vaultPath, alias);
    expect(() => exportVault(db, vaultPath, join(alias, "nested"))).toThrow(
      /must not be inside the vault/,
    );
    db.close();
  });

  test("does not chmod an existing parent directory", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    chmodSync(parent, 0o755);
    exportVault(db, vaultPath, join(parent, "dump"));
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);
    db.close();
  });

  test("refuses an unsafe shared parent without changing its permissions", () => {
    const { db, vaultPath } = populated();
    const parent = temporary("kizuki-export-parent-");
    chmodSync(parent, 0o777);
    expect(() => exportVault(db, vaultPath, join(parent, "dump"))).toThrow("owned_directory_publication_unsafe");
    expect(lstatSync(parent).mode & 0o777).toBe(0o777);
    expect(readdirSync(parent)).toEqual([]);
    db.close();
  });

  test("writes owner-only files even under a permissive umask", () => {
    const { db, vaultPath } = populated();
    const previous = process.umask(0o000);
    try {
      const outDir = join(temporary("kizuki-export-parent-"), "dump");
      exportVault(db, vaultPath, outDir);
      expect(lstatSync(outDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(outDir, "manifest.json")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(outDir, "ledger", "events.jsonl")).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      process.umask(previous);
    }
    db.close();
  });

  test("refuses an existing destination that is world-accessible", () => {
    const { db, vaultPath } = populated();
    const outDir = temporary("kizuki-export-open-");
    chmodSync(outDir, 0o777);
    expect(() => exportVault(db, vaultPath, outDir)).toThrow(/owner-only/);
    db.close();
  });

  test("excludes an unclassified large binary without copying its payload", () => {
    const { db, vaultPath } = populated();
    const blob = Buffer.alloc(4 * 1024 * 1024, 7);
    writeFileSync(join(vaultPath, "blob.bin"), blob);
    const before = process.memoryUsage().rss;
    const outDir = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, outDir);
    const after = process.memoryUsage().rss;
    expect(manifest.files["vault/blob.bin"]).toBeUndefined();
    expect(after - before).toBeLessThan(48 * 1024 * 1024);
    db.close();
  });
});

describe("restoreVault", () => {
  test("restores ledger rows and vault bytes into a clean target", () => {
    const { db, vaultPath, remainingEventId } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    const report = restoreVault(backup, target);

    expect(report.events).toBe(1);
    expect(report.vault_files).toBeGreaterThan(0);
    expect(existsSync(join(target, "notes.txt"))).toBe(false);
    expect(readFileSync(join(target, "people", "Ada.md"), "utf8")).toContain("Ada");
    expect(existsSync(join(target, ".kizuki"))).toBe(true);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<{ event_id: string }, []>("SELECT event_id FROM events")
        .all()
        .map((row) => row.event_id),
    ).toEqual([remainingEventId]);
    expect(
      restored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM event_purges")
        .get()?.count,
    ).toBe(1);
    expect(
      restored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM connections")
        .get()?.count,
    ).toBe(1);
    expect(
      restored
        .query<{ implementation_version: string }, []>(
          "SELECT implementation_version FROM connections",
        )
        .get()?.implementation_version,
    ).toBe("fixture@1");
    restored.close();
    db.close();
  });

  test("verify-only refuses a torn or incomplete backup", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    writeFileSync(join(backup, ".kizuki-backup-incomplete"), "incomplete\n");
    expect(() => verifyBackup(backup)).toThrow(/incomplete/);
    rmSync(join(backup, ".kizuki-backup-incomplete"));
    writeFileSync(join(backup, "ledger", "events.jsonl"), "{not-json\n", {
      flag: "w",
    });
    expect(() => verifyBackup(backup)).toThrow(/hash mismatch/);
    db.close();
  });

  test("does not recursively delete a restore target that filled later", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(() =>
      restoreVault(backup, target, {
        onProgress: (label) => {
          if (label === "vault" && !existsSync(target)) {
            mkdirSync(target);
            writeFileSync(join(target, "keep.txt"), "keep\n");
          }
        },
      }),
    ).toThrow(/not empty/);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
    db.close();
  });

  test("refuses restore into an existing populated target", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = temporary("kizuki-restore-occupied-");
    writeFileSync(join(target, "keep.txt"), "keep\n");
    expect(() => restoreVault(backup, target)).toThrow(/not empty/);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep\n");
    db.close();
  });

  test("does not select an unrelated vault file named INCOMPLETE", () => {
    const { db, vaultPath } = populated();
    writeFileSync(join(vaultPath, "INCOMPLETE"), "vault-marker\n");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    expect(existsSync(join(target, "INCOMPLETE"))).toBe(false);
    db.close();
  });

  test("restores claims, bindings, supersessions, proposals, and page_index", () => {
    const { db, vaultPath } = populated();
    insertFixtureClaim(db, "Ada works at Acme.");
    db.query(
      `INSERT INTO claim_supersessions
         (winner, loser, rule, prior_valid_to, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "01EXPORTCLAIM00000000000001",
      "01EXPORTLOSER00000000000001",
      "later_wins",
      null,
      "01EXPORTRECEIPT00000000001",
      "2026-01-01T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO claim_bindings (claim_key, page_id, bound_at) VALUES (?, ?, ?)`,
    ).run(
      "person:ada|employment.works_at",
      "ada",
      "2026-01-01T00:00:00.000Z",
    );
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    expect(manifest.files["claims/claims.jsonl"]?.count).toBe(1);
    expect(manifest.files["claims/supersessions.jsonl"]?.count).toBe(1);
    expect(manifest.files["claims/bindings.jsonl"]?.count).toBe(1);

    const target = join(temporary("kizuki-restore-parent-"), "vault");
    const report = restoreVault(backup, target);
    expect(report.claims).toBe(1);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<{ claim_id: string }, []>("SELECT claim_id FROM claims")
        .all()
        .map((row) => row.claim_id),
    ).toEqual(["01EXPORTCLAIM00000000000001"]);
    expect(
      restored
        .query<{ proposal_id: string }, []>("SELECT proposal_id FROM proposals")
        .all()
        .map((row) => row.proposal_id),
    ).toEqual(["01EXPORTCLAIM00000000000001"]);
    expect(
      restored
        .query<{ loser: string }, []>("SELECT loser FROM claim_supersessions")
        .all()
        .map((row) => row.loser),
    ).toEqual(["01EXPORTLOSER00000000000001"]);
    expect(
      restored
        .query<{ page_id: string }, []>("SELECT page_id FROM claim_bindings")
        .all()
        .map((row) => row.page_id),
    ).toEqual(["ada"]);
    expect(
      restored
        .query<{ page_id: string; rel_path: string }, []>(
          "SELECT page_id, rel_path FROM page_index ORDER BY page_id",
        )
        .all(),
    ).toEqual([{ page_id: "ada", rel_path: "people/Ada.md" }]);
    restored.close();
    db.close();
  });

  test("restore keeps split content signatures so a refile stays a duplicate", () => {
    const { db, vaultPath, remainingEventId } = populated();
    const { first, second, shared } = fileSplitSignatures(db, remainingEventId);
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const exported = readFileSync(join(backup, "claims", "claims.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { claim_id: string; content_hash: unknown })
      .filter((row) => row.claim_id === first.proposal_id || row.claim_id === second.proposal_id);
    expect(exported).toHaveLength(2);
    expect(exported[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(exported[1]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(exported[0]?.content_hash).not.toBe(exported[1]?.content_hash);
    expect(manifest.files["claims/claims.jsonl"]?.count).toBeGreaterThanOrEqual(2);

    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    const rows = liveSplitSignatures(restored);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.claim_id).sort()).toEqual(
      [first.proposal_id, second.proposal_id].sort(),
    );
    expect(rows[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.content_hash).not.toBe(rows[1]?.content_hash);

    const again = fileProposal(restored, {
      ...shared,
      frontmatter: { type: "fact", title: "one" },
    });
    expect(again.outcome).toBe("duplicate");
    if (again.outcome === "duplicate") {
      expect(again.proposal.proposal_id).toBe(first.proposal_id);
    }
    restored.close();
    db.close();
  });

  test("restore heals an old backup that omitted claim content hashes", () => {
    const { db, vaultPath, remainingEventId } = populated();
    const { first, second, shared } = fileSplitSignatures(db, remainingEventId);
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    rewriteClaimsJsonl(backup, manifest, (row) => {
      const { content_hash: _omitted, ...rest } = row;
      void _omitted;
      return rest;
    });

    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    const rows = liveSplitSignatures(restored);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.claim_id).sort()).toEqual(
      [first.proposal_id, second.proposal_id].sort(),
    );
    expect(rows[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.content_hash).not.toBe(rows[1]?.content_hash);

    const again = fileProposal(restored, {
      ...shared,
      frontmatter: { type: "fact", title: "two" },
    });
    expect(again.outcome).toBe("duplicate");
    if (again.outcome === "duplicate") {
      expect(again.proposal.proposal_id).toBe(second.proposal_id);
    }
    restored.close();
    db.close();
  });

  test("restores identity links and connector sensitivity", () => {
    const { db, vaultPath, sourceKey } = populated();
    db.query(
      `INSERT INTO identity_links
         (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "person:ada",
      "person:a.lovelace",
      0.96,
      JSON.stringify(["evt-1"]),
      "merged",
      "owner",
      null,
      "2026-01-01T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO connector_sensitivity
         (connector_id, source_key, default_sensitivity, floor, set_by, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "fixture",
      sourceKey,
      "personal",
      "personal",
      "manifest",
      "2026-01-01T00:00:00.000Z",
    );
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    expect(manifest.schema).toBe("kizuki.backup/v3");
    expect(manifest.files["claims/identity_links.jsonl"]?.count).toBe(1);
    expect(JSON.parse(readFileSync(join(backup, "claims", "identity_links.jsonl"), "utf8")).evidence).toEqual({
      encoding: "kizuki.identity-evidence/raw-v1",
      raw: '["evt-1"]',
    });
    expect(manifest.files["ledger/connector_sensitivity.jsonl"]?.count).toBe(1);

    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<
          {
            subject_a: string;
            subject_b: string;
            score: number;
            evidence: string;
            status: string;
          },
          []
        >(
          `SELECT subject_a, subject_b, score, evidence, status
           FROM identity_links`,
        )
        .get(),
    ).toEqual({
      subject_a: "person:ada",
      subject_b: "person:a.lovelace",
      score: 0.96,
      evidence: '["evt-1"]',
      status: "merged",
    });
    expect(() => listSubjectAliases(restored, "person:ada")).toThrow(
      "identity authority unavailable",
    );
    expect(
      restored
        .query<
          {
            connector_id: string;
            source_key: string;
            default_sensitivity: string;
            floor: string;
          },
          []
        >(
          `SELECT connector_id, source_key, default_sensitivity, floor
           FROM connector_sensitivity`,
        )
        .get(),
    ).toEqual({
      connector_id: "fixture",
      source_key: sourceKey,
      default_sensitivity: "personal",
      floor: "personal",
    });
    restored.close();
    db.close();
  });

  test("imports a genuine v2 identity evidence array as inert raw bytes", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const key = "claims/identity_links.jsonl";
    const payload = Buffer.from(`${JSON.stringify({
      subject_a: "person:legacy-a", subject_b: "person:legacy-b", score: 1,
      evidence: ["event:legacy-v2"], status: "candidate", decided_by: "legacy", receipt_id: null,
      at: "2026-01-01T00:00:00.000Z",
    })}\n`);
    writeFileSync(join(backup, "claims", "identity_links.jsonl"), payload);
    const files = { ...manifest.files, [key]: {
      count: 1, size: payload.byteLength, mode: 0o600,
      sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
    } };
    writeSignedManifest(backup, { ...manifest, schema: "kizuki.backup/v2", files: legacyFiles(backup, files) });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(restoreVault(backup, target).recovery_warnings.join(" ")).toContain("historical purge");
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(restored.query<{ evidence: string }, []>("SELECT evidence FROM identity_links").get()?.evidence)
      .toBe('["event:legacy-v2"]');
    expect(() => listSubjectAliases(restored, "person:legacy-a")).toThrow("identity authority unavailable");
    restored.close();
    db.close();
  });

  test("v3 preserves opaque valid identity evidence bytes exactly", () => {
    const { db, vaultPath } = populated();
    const evidence = '[  "event:legacy-emoji-😀" ]';
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:space-a", "person:space-b", 1, evidence, "candidate", "legacy", "2026-01-01T00:00:00.000Z");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(restored.query<{ evidence: string }, []>("SELECT evidence FROM identity_links").get()?.evidence).toBe(evidence);
    restored.close();
    db.close();
  });

  test("v3 identity evidence rejects malformed tags before target publication", () => {
    const cases: readonly unknown[] = [
      {},
      { encoding: "kizuki.identity-evidence/raw-v1" },
      { encoding: "kizuki.identity-evidence/raw-v1", raw: "x".repeat(16_385) },
      { encoding: "kizuki.identity-evidence/raw-v1", raw: "\ud800" },
      { encoding: "kizuki.identity-evidence/raw-v1", raw: "[]", extra: true },
    ];
    for (const evidence of cases) {
      const { db, vaultPath } = populated();
      const backup = join(temporary("kizuki-export-parent-"), "dump");
      const manifest = exportVault(db, vaultPath, backup);
      const key = "claims/identity_links.jsonl";
      const payload = Buffer.from(`${JSON.stringify({
        subject_a: "person:a", subject_b: "person:b", score: 1, evidence,
        status: "candidate", decided_by: "legacy", receipt_id: null, at: "2026-01-01T00:00:00.000Z",
      })}\n`);
      writeFileSync(join(backup, "claims", "identity_links.jsonl"), payload);
      const files = { ...manifest.files, [key]: {
        count: 1, size: payload.byteLength, mode: 0o600,
        sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
      } };
      writeSignedManifest(backup, { ...manifest, files });
      const target = join(temporary("kizuki-restore-parent-"), "vault");
      expect(() => restoreVault(backup, target)).toThrow(/identity evidence/);
      expect(existsSync(target)).toBe(false);
      db.close();
    }
  });

  test.each(["terminated", "unterminated"])("v3 restore refuses invalid UTF-8 JSONL before target publication (%s)", (ending) => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const key = "claims/identity_links.jsonl";
    const payload = Buffer.concat([
      Buffer.from('{"subject_a":"person:a","subject_b":"person:b","score":1,"evidence":{"encoding":"kizuki.identity-evidence/raw-v1","raw":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"},"status":"candidate","decided_by":"legacy","receipt_id":null,"at":"2026-01-01T00:00:00.000Z"}' + (ending === "terminated" ? "\n" : "")),
    ]);
    writeFileSync(join(backup, "claims", "identity_links.jsonl"), payload);
    writeSignedManifest(backup, {
      ...manifest,
      files: {
        ...manifest.files,
        [key]: {
          count: 1, size: payload.byteLength, mode: 0o600,
          sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
        },
      },
    });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(() => restoreVault(backup, target)).toThrow();
    expect(existsSync(target)).toBe(false);
    db.close();
  });

  test("refuses retained identity hashes until resumed source erasure scrubs them", async () => {
    const { db, vaultPath, sourceKey } = populated();
    grantExport(db, sourceKey);
    revokeSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 1,
      operation_id: "scrub-legacy-identity-hash",
    });
    const options = { ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) } };
    expect((await resumeSourceRevocation(db, vaultPath, "scrub-legacy-identity-hash", options)).status).toBe("purged");
    // An upgraded old purged report can still contain retired endpoint hashes.
    // Stored status must not bypass the current export guard.
    db.query("UPDATE source_store_inventory SET erasure_report=? WHERE source_key=?")
      .run(erasureReport(["legacy-endpoint-hash"]), sourceKey);
    const refused = join(temporary("kizuki-export-parent-"), "refused");
    expect(() => exportVault(db, vaultPath, refused)).toThrow(
      "legacy_identity_erasure_reconciliation_required",
    );
    expect(existsSync(refused)).toBe(false);
    const resumed = await resumeSourceRevocation(db, vaultPath, "scrub-legacy-identity-hash", options);
    expect(resumed.status).toBe("purged");
    expect(JSON.parse(db.query<{ erasure_report: string }, [string]>(
      "SELECT erasure_report FROM source_store_inventory WHERE source_key=?",
    ).get(sourceKey)?.erasure_report ?? "null")).toMatchObject({
      affected_identity_hashes: [],
    });
    const unsafeBackup = join(temporary("kizuki-export-parent-"), "unsafe");
    const unsafeManifest = exportVault(db, vaultPath, unsafeBackup);
    const inventoryPath = join(unsafeBackup, "ledger", "source_store_inventory.jsonl");
    const unsafeRow = JSON.parse(readFileSync(inventoryPath, "utf8"));
    unsafeRow.erasure_report = erasureReport(["restored-legacy-hash"]);
    const unsafePayload = Buffer.from(`${JSON.stringify(unsafeRow)}\n`);
    writeFileSync(inventoryPath, unsafePayload);
    writeSignedManifest(unsafeBackup, {
      ...unsafeManifest,
      files: {
        ...unsafeManifest.files,
        ["ledger/source_store_inventory.jsonl"]: {
          count: 1, size: unsafePayload.byteLength, mode: 0o600,
          sha256: new Bun.CryptoHasher("sha256").update(unsafePayload).digest("hex"),
        },
      },
    });
    const unsafeTarget = join(temporary("kizuki-restore-parent-"), "unsafe");
    expect(() => restoreVault(unsafeBackup, unsafeTarget)).toThrow(
      "legacy_identity_erasure_reconciliation_required",
    );
    expect(existsSync(unsafeTarget)).toBe(false);

    const backup = join(temporary("kizuki-export-parent-"), "clean");
    exportVault(db, vaultPath, backup);
    expect(JSON.parse(
      JSON.parse(readFileSync(join(backup, "ledger", "source_store_inventory.jsonl"), "utf8"))
        .erasure_report,
    )).toMatchObject({ affected_identity_hashes: [] });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(JSON.parse(restored.query<{ erasure_report: string }, [string]>(
      "SELECT erasure_report FROM source_store_inventory WHERE source_key=?",
    ).get(sourceKey)?.erasure_report ?? "null")).toMatchObject({
      affected_identity_hashes: [],
    });
    restored.close();
    db.close();
  });

  test("refuses malformed SQLite UTF-8 identity evidence before export publication", () => {
    const { db, vaultPath } = populated();
    db.exec("DROP TABLE identity_links");
    db.exec(`CREATE TABLE identity_links (
      subject_a TEXT NOT NULL, subject_b TEXT NOT NULL, score REAL NOT NULL,
      evidence BLOB NOT NULL, status TEXT NOT NULL, decided_by TEXT NOT NULL,
      receipt_id TEXT, at TEXT NOT NULL, PRIMARY KEY (subject_a, subject_b)
    )`);
    db.query("INSERT INTO identity_links VALUES (?,?,?,?,?,?,NULL,?)")
      .run("person:bad-a", "person:bad-b", 1, Buffer.from([0xc3, 0x28]), "candidate", "legacy", "2026-01-01T00:00:00.000Z");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    expect(() => exportVault(db, vaultPath, backup)).toThrow(/identity|UTF-8/i);
    expect(existsSync(backup)).toBe(false);
    db.close();
  });

  test("refuses oversized source erasure reports before backup publication", () => {
    const { db, vaultPath, sourceKey } = populated();
    grantExport(db, sourceKey);
    const report = JSON.stringify({ affected_identity_hashes: [], padding: "x".repeat(2_000_000) });
    db.query(`INSERT INTO source_store_inventory
      (source_key,checked,payload_complete,erasure_report) VALUES (?,1,1,?)`).run(sourceKey, report);
    const target = join(temporary("kizuki-export-parent-"), "oversized");
    expect(() => exportVault(db, vaultPath, target)).toThrow("legacy_identity_erasure_reconciliation_required");
    expect(existsSync(target)).toBe(false);
    db.close();
  });

  test("normalizes a missing legacy identity-hash compatibility field on restore", () => {
    const { db, vaultPath, sourceKey } = populated();
    grantExport(db, sourceKey);
    db.query(`INSERT INTO source_store_inventory
      (source_key,checked,payload_complete,erasure_report) VALUES (?,1,1,?)`)
      .run(sourceKey, erasureReport());
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const inventoryPath = join(backup, "ledger", "source_store_inventory.jsonl");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const report = JSON.parse(inventory.erasure_report);
    delete report.affected_identity_hashes;
    inventory.erasure_report = JSON.stringify(report);
    const payload = Buffer.from(`${JSON.stringify(inventory)}\n`);
    writeFileSync(inventoryPath, payload);
    writeSignedManifest(backup, {
      ...manifest,
      schema: "kizuki.backup/v2",
      files: legacyFiles(backup, {
        ...manifest.files,
        ["ledger/source_store_inventory.jsonl"]: {
          count: 1, size: payload.byteLength, mode: 0o600,
          sha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
        },
      }),
    });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(restoreVault(backup, target).recovery_warnings.join(" ")).toContain("historical purge");
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(JSON.parse(restored.query<{ erasure_report: string }, [string]>(
      "SELECT erasure_report FROM source_store_inventory WHERE source_key=?",
    ).get(sourceKey)?.erasure_report ?? "null")).toMatchObject({
      affected_identity_hashes: [],
    });
    restored.close();
    db.close();
  });

  test("restores backups that omit identity links and connector sensitivity", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    rmSync(join(backup, "claims", "identity_links.jsonl"));
    rmSync(join(backup, "ledger", "connector_sensitivity.jsonl"));
    const files = { ...manifest.files };
    delete files["claims/identity_links.jsonl"];
    delete files["ledger/connector_sensitivity.jsonl"];
    writeSignedManifest(backup, { ...manifest, schema: "kizuki.backup/v2", files: legacyFiles(backup, files) });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    const report = restoreVault(backup, target);
    expect(report.events).toBe(1);
    expect(report.recovery_warnings.join(" ")).toContain("historical purge");
    db.close();
  });

  test("v3 restore requires the identity stream before publishing a target", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    rmSync(join(backup, "claims", "identity_links.jsonl"));
    const files = { ...manifest.files };
    delete files["claims/identity_links.jsonl"];
    writeSignedManifest(backup, { ...manifest, files });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(() => restoreVault(backup, target)).toThrow(/identity.*stream/i);
    expect(existsSync(target)).toBe(false);
    db.close();
  });

  test("removes the staging directory when restore setup fails", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const parent = temporary("kizuki-restore-parent-");
    const target = join(parent, "vault");
    expect(() =>
      restoreVault(backup, target, {
        onProgress: (label) => {
          if (label === "staging") throw new Error("injected staging failure");
        },
      }),
    ).toThrow(/injected staging failure/);
    expect(existsSync(target)).toBe(false);
    expect(
      readdirSync(parent).some((name) => name.includes(".kizuki-backup-")),
    ).toBe(false);
    db.close();
  });

  test("restores a JSONL line whose UTF-8 character straddles a 64KiB chunk", () => {
    const { db, vaultPath } = populated();
    const body = utf8BodyOnChunkBoundary();
    insertFixtureClaim(db, body, "01EXPORTUTF8CLAIM0000000001");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const bytes = readFileSync(join(backup, "claims", "claims.jsonl"));
    expect(bytes.subarray(65_535, 65_538)).toEqual(Buffer.from("中"));
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<{ body: string }, []>("SELECT body FROM claims")
        .get()?.body,
    ).toBe(body);
    restored.close();
    db.close();
  });

  test("refuses a backup that plants the control directory", () => {
    for (const plantedName of [".kizuki", ".Kizuki"] as const) {
      const { db, vaultPath } = populated();
      const backup = join(temporary("kizuki-export-parent-"), "dump");
      const manifest = exportVault(db, vaultPath, backup);
      const planted = join(backup, "vault", plantedName, "vault-id");
      mkdirSync(join(backup, "vault", plantedName), { recursive: true, mode: 0o700 });
      writeFileSync(planted, "01plantedvaultid000000000001\n");
      chmodSync(planted, 0o600);
      const bytes = readFileSync(planted);
      writeSignedManifest(backup, {
        ...manifest,
        files: {
          ...manifest.files,
          [`vault/${plantedName}/vault-id`]: {
            count: 1,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
            mode: 0o600,
          },
        },
      });
      const target = join(temporary("kizuki-restore-parent-"), "vault");
      expect(() => verifyBackup(backup)).toThrow(/control directory/);
      expect(() => restoreVault(backup, target)).toThrow(/control directory/);
      expect(existsSync(join(target, ".kizuki"))).toBe(false);
      db.close();
    }
  });

  test("refuses a vault path that would escape the restore target", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const notes = manifest.files["vault/people/Ada.md"];
    if (notes === undefined) throw new Error("expected vault/people/Ada.md");
    const files = { ...manifest.files };
    delete files["vault/people/Ada.md"];
    files["vault//tmp/kizuki-export-escape"] = notes;
    writeSignedManifest(backup, { ...manifest, files });
    const outside = join(tmpdir(), "kizuki-export-escape");
    rmSync(outside, { force: true });
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(() => restoreVault(backup, target)).toThrow(/invalid/);
    expect(existsSync(outside)).toBe(false);
    db.close();
  });

  test("reads a manifest whose UTF-8 character straddles a 64KiB chunk", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    const empty = writeSignedManifest(backup, { ...manifest, created_at: "" });
    const prefix =
      `${JSON.stringify(empty, null, 2)}\n`.indexOf('"created_at": "') +
      '"created_at": "'.length;
    const pad = 65_535 - Buffer.byteLength(
      `${JSON.stringify(empty, null, 2)}\n`.slice(0, prefix),
    );
    const created_at = `${"a".repeat(pad)}中`;
    const signed = writeSignedManifest(backup, { ...manifest, created_at });
    const bytes = readFileSync(join(backup, "manifest.json"));
    expect(bytes.subarray(65_535, 65_538)).toEqual(Buffer.from("中"));
    expect(verifyBackup(backup).created_at).toBe(created_at);
    expect(verifyBackup(backup).manifest_sha256).toBe(signed.manifest_sha256);
    db.close();
  });

  test("restores the durable receipt claim kind", () => {
    const { db, vaultPath } = populated();
    insertFixtureReceipt(db, "purge_review");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    exportVault(db, vaultPath, backup);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(
      restored
        .query<{ kind: string; receipt_kind: string }, []>(
          "SELECT kind, receipt_kind FROM canon_receipts",
        )
        .get(),
    ).toEqual({ kind: "purge_review", receipt_kind: "write" });
    restored.close();
    db.close();
  });

  test("snapshot event_count matches the exported event stream", () => {
    const { db, vaultPath } = populated();
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup, {
      onProgress: (label) => {
        if (label === "claims") {
          const extra = accept(db, { ...validEvent(), source_record_id: "rec-race" });
          if (extra.status !== "stored") throw new Error("expected stored extra event");
        }
      },
    });
    expect(manifest.files["ledger/events.jsonl"]?.count).toBe(1);
    expect(manifest.snapshot.event_count).toBe(1);
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    expect(restoreVault(backup, target).events).toBe(1);
    db.close();
  });

  test("rechecks source erasure reports after progress callbacks", () => {
    const { db, vaultPath, sourceKey } = populated();
    grantExport(db, sourceKey);
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    expect(() => exportVault(db, vaultPath, backup, {
      onProgress: (label) => {
        if (label === "claims") {
          db.query(`INSERT INTO source_store_inventory
            (source_key,checked,payload_complete,erasure_report) VALUES (?,1,1,?)`)
            .run(sourceKey, erasureReport(["reinserted-legacy-hash"]));
        }
      },
    })).toThrow("legacy_identity_erasure_reconciliation_required");
    expect(existsSync(backup)).toBe(false);
    db.close();
  });

  test("preserves vault identity when the source had one", () => {
    const { db, vaultPath } = populated();
    writeFileSync(join(vaultPath, ".kizuki", "vault-id"), "01exportvaultid000000000001\n");
    const backup = join(temporary("kizuki-export-parent-"), "dump");
    const manifest = exportVault(db, vaultPath, backup);
    expect(manifest.vault_id).toBe("01exportvaultid000000000001");
    const target = join(temporary("kizuki-restore-parent-"), "vault");
    restoreVault(backup, target);
    expect(readVaultId(target)).toBe("01exportvaultid000000000001");
    db.close();
  });
});
