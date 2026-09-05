import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SCHEMA,
  LEGACY_BACKUP_SCHEMA,
  exportVault,
  restoreVault,
  verifyBackup,
  type ExportManifest,
  type ExportManifestEntry,
} from "../src/export";
import { openLedger } from "../src/ledger/db";
import { accept, readSince } from "../src/ledger/ledger";
import { commitMachineByteIntent } from "../src/ledger/event-origin";
import { recordNativeCorrection } from "../src/correction/evidence";
import { computeLegacyContentHash, sha256Hex } from "../src/util/hash";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";

const directories: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const vault = temporary("kizuki-event-backup-v2-vault-");
  initVault(vault);
  const db = openLedger(":memory:");
  const stored = accept(db, validEvent());
  if (stored.status !== "stored") throw new Error("fixture event was not stored");
  const backup = join(temporary("kizuki-event-backup-v2-backup-"), "dump");
  const manifest = exportVault(db, vault, backup);
  return { backup, db, manifest, vault };
}

function hash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function readManifest(backup: string): ExportManifest {
  return JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
}

function signManifest(backup: string, manifest: ExportManifest): void {
  const files: Record<string, ExportManifestEntry> = {};
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
    manifest_sha256: hash(Buffer.from(`${JSON.stringify(unsigned, null, 2)}\n`)),
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`);
  chmodSync(join(backup, "manifest.json"), 0o600);
}

function writeJsonl(
  backup: string,
  manifest: ExportManifest,
  path: string,
  rows: readonly Record<string, unknown>[],
): void {
  const bytes = Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  writeFileSync(join(backup, path), bytes);
  chmodSync(join(backup, path), 0o600);
  manifest.files[path] = { count: rows.length, sha256: hash(bytes), size: bytes.byteLength, mode: 0o600 };
}

function onlyEvent(backup: string): Record<string, unknown> {
  const rows = readFileSync(join(backup, "ledger/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (rows.length !== 1) throw new Error("expected one fixture event");
  return rows[0]!;
}

test("exports v2 records with spine fields and the required empty intent stream", () => {
  const { backup, db, manifest } = fixture();
  expect(manifest.schema).toBe(BACKUP_SCHEMA);
  expect(manifest.files["ledger/canon-machine-byte-intents.jsonl"]?.count).toBe(0);
  expect(readFileSync(join(backup, "ledger/canon-machine-byte-intents.jsonl"), "utf8")).toBe("");
  expect(onlyEvent(backup)).toMatchObject({
    content_hash_version: 2,
    text_hash: sha256Hex(validEvent().text),
    origin: "external",
  });
  db.close();
});

test("requires the v2 intent stream even when it is empty", () => {
  const { backup, db } = fixture();
  const manifest = readManifest(backup);
  unlinkSync(join(backup, "ledger/canon-machine-byte-intents.jsonl"));
  delete manifest.files["ledger/canon-machine-byte-intents.jsonl"];
  signManifest(backup, manifest);
  expect(() => verifyBackup(backup)).toThrow(/intent stream is missing/);
  db.close();
});

test("rejects a re-signed v2 text-hash forgery before publishing the target", () => {
  const { backup, db } = fixture();
  const manifest = readManifest(backup);
  const event = onlyEvent(backup);
  event.text_hash = "b".repeat(64);
  writeJsonl(backup, manifest, "ledger/events.jsonl", [event]);
  signManifest(backup, manifest);
  const target = join(temporary("kizuki-event-backup-v2-restore-"), "vault");
  expect(() => restoreVault(backup, target)).toThrow();
  expect(existsSync(target)).toBe(false);
  db.close();
});

test("rejects a re-signed v2 external event that matches a loop receipt", () => {
  const { backup, db } = fixture();
  const manifest = readManifest(backup);
  writeJsonl(backup, manifest, "canon/receipts.jsonl", [{
    receipt_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "write",
    claim_ids: [],
    page_path: "people/fixture.md",
    page_action: "create",
    before_hash: null,
    after_hash: sha256Hex(validEvent().text),
    archive_path: null,
    writer: "loop",
    producer: "deterministic",
    model_ref: null,
    authority: "connector_evidence",
    confidence: 1,
    sensitivity: "personal",
    taint: "quoted",
    provenance: [],
    superseded: [],
    candidates: [],
    retrieval_ops: [],
    reverts: null,
    reverted_by: null,
    at: "2026-01-01T00:00:00.000Z",
    claim_kind: "claim",
  }]);
  signManifest(backup, manifest);
  const target = join(temporary("kizuki-event-backup-v2-origin-"), "vault");
  expect(() => restoreVault(backup, target)).toThrow(/origin is inconsistent/);
  expect(existsSync(target)).toBe(false);
  db.close();
});

test("imports an exact legacy v1 record and annotates it under the v2 schema", () => {
  const { backup, db } = fixture();
  const manifest = readManifest(backup);
  const current = onlyEvent(backup);
  const input = {
    schema: current.schema,
    connector_id: current.connector_id,
    source_record_id: current.source_record_id,
    kind: current.kind,
    occurred_at: current.occurred_at,
    observed_at: current.observed_at,
    text: current.text,
    subjects: current.subjects,
    ...(current.sensitivity_hint === undefined ? {} : { sensitivity_hint: current.sensitivity_hint }),
    deleted: current.deleted,
    attachments: current.attachments,
    metadata: current.metadata,
  };
  const { content_hash_version: _version, text_hash: _textHash, origin: _origin, ...legacy } = current;
  legacy.content_hash = computeLegacyContentHash(input as ReturnType<typeof validEvent>);
  manifest.schema = LEGACY_BACKUP_SCHEMA;
  manifest.schema_versions = { ...manifest.schema_versions, ledger: 15 };
  writeJsonl(backup, manifest, "ledger/events.jsonl", [legacy]);
  unlinkSync(join(backup, "ledger/canon-machine-byte-intents.jsonl"));
  delete manifest.files["ledger/canon-machine-byte-intents.jsonl"];
  signManifest(backup, manifest);

  const target = join(temporary("kizuki-event-backup-v1-restore-"), "vault");
  restoreVault(backup, target);
  const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
  expect(
    restored.query<{ content_hash_version: number; text_hash: string; origin: string }, []>(
      "SELECT content_hash_version, text_hash, origin FROM events",
    ).get(),
  ).toEqual({ content_hash_version: 1, text_hash: sha256Hex(validEvent().text), origin: "external" });
  restored.close();
  db.close();
});

test("refuses a v1 envelope that carries a v2-only event field", () => {
  const { backup, db } = fixture();
  const manifest = readManifest(backup);
  manifest.schema = LEGACY_BACKUP_SCHEMA;
  manifest.schema_versions = { ...manifest.schema_versions, ledger: 15 };
  unlinkSync(join(backup, "ledger/canon-machine-byte-intents.jsonl"));
  delete manifest.files["ledger/canon-machine-byte-intents.jsonl"];
  signManifest(backup, manifest);
  const target = join(temporary("kizuki-event-backup-v1-swapped-"), "vault");
  expect(() => restoreVault(backup, target)).toThrow();
  expect(existsSync(target)).toBe(false);
  db.close();
});

test.each([
  ["unknown hash version", (row: Record<string, unknown>) => { row.content_hash_version = 3; }],
  ["missing hash version", (row: Record<string, unknown>) => { delete row.content_hash_version; }],
  ["declared v1 with v2 hash", (row: Record<string, unknown>) => { row.content_hash_version = 1; }],
  ["unknown spine field", (row: Record<string, unknown>) => { row.authority = "owner"; }],
  ["unknown origin", (row: Record<string, unknown>) => { row.origin = "owner"; }],
  ["revision hash tamper", (row: Record<string, unknown>) => { row.content_hash = "b".repeat(64); }],
  ["attachment revision tamper", (row: Record<string, unknown>) => { row.attachments = []; }],
  ["sensitivity revision tamper", (row: Record<string, unknown>) => { row.sensitivity_hint = "private"; }],
] as const)("rejects re-signed current event %s without publishing partial restore", (_name, mutate) => {
  const { backup, db } = fixture();
  try {
    const manifest = readManifest(backup);
    const row = onlyEvent(backup);
    mutate(row);
    writeJsonl(backup, manifest, "ledger/events.jsonl", [row]);
    signManifest(backup, manifest);
    const target = join(temporary("kizuki-backup-invalid-event-"), "vault");
    expect(() => restoreVault(backup, target)).toThrow();
    expect(existsSync(target)).toBe(false);
  } finally { db.close(); }
});

test("roundtrips mixed v1 and v2 revision hashes without changing legacy evidence", () => {
  const { backup, db, vault } = fixture();
  try {
    const original = readSince(db, null, 1).events[0]!;
    const legacyHash = computeLegacyContentHash(validEvent());
    db.query("UPDATE events SET content_hash_version=1,content_hash=? WHERE event_id=?").run(legacyHash, original.event_id);
    const current = accept(db, { ...validEvent(), source_record_id: "current-revision", sensitivity_hint: "private" });
    if (current.status !== "stored") throw new Error("fixture failed");
    rmSync(backup, { recursive: true });
    exportVault(db, vault, backup);
    const target = join(temporary("kizuki-backup-mixed-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(readSince(restored, null, 10).events).toEqual([
        { ...original, content_hash_version: 1, content_hash: legacyHash }, current.event,
      ]);
      expect(accept(restored, validEvent()).status).toBe("duplicate");
      expect(accept(restored, { ...validEvent(), attachments: [] }).status).toBe("stored");
    } finally { restored.close(); }
  } finally { db.close(); }
});

test("exports refreshed self origin and preserves unfinished byte intents through restore", () => {
  const { backup, db, vault } = fixture();
  const intent = { receipt_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", before_hash: null, after_hash: sha256Hex(validEvent().text) };
  try {
    commitMachineByteIntent(db, intent, () => undefined);
    rmSync(backup, { recursive: true });
    exportVault(db, vault, backup);
    expect(onlyEvent(backup).origin).toBe("self");
    const target = join(temporary("kizuki-backup-intent-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(restored.query("SELECT * FROM canon_machine_byte_intents").get()).toEqual(intent);
      expect(accept(restored, { ...validEvent(), source_record_id: "recaptured-intent" }))
        .toMatchObject({ status: "stored", event: { origin: "self" } });
    } finally { restored.close(); }
  } finally { db.close(); }
});

test.each(["duplicate", "invalid hash", "missing field", "extra field", "oversized row", "external match"])(
  "refuses a re-signed byte-intent stream with %s", (mutation) => {
    const { backup, db } = fixture();
    try {
      const manifest = readManifest(backup);
      const row: Record<string, unknown> = { receipt_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", before_hash: null, after_hash: "a".repeat(64) };
      if (mutation === "invalid hash") row.after_hash = "x".repeat(64);
      if (mutation === "missing field") delete row.before_hash;
      if (mutation === "extra field") row.origin = "external";
      if (mutation === "oversized row") row.after_hash = "a".repeat(100_000);
      if (mutation === "external match") row.after_hash = sha256Hex(validEvent().text);
      writeJsonl(backup, manifest, "ledger/canon-machine-byte-intents.jsonl", mutation === "duplicate" ? [row, row] : [row]);
      signManifest(backup, manifest);
      const target = join(temporary("kizuki-backup-invalid-intent-"), "vault");
      expect(() => restoreVault(backup, target)).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally { db.close(); }
  },
);

test("refuses a legacy envelope declaring the current ledger schema", () => {
  const { backup, db } = fixture();
  try {
    const manifest = readManifest(backup);
    manifest.schema = LEGACY_BACKUP_SCHEMA;
    signManifest(backup, manifest);
    expect(() => verifyBackup(backup)).toThrow();
  } finally { db.close(); }
});

test("native owner evidence survives exact restore and ordinary connector evidence cannot acquire it", () => {
  const { backup, db, vault } = fixture();
  try {
    const request = sha256Hex("native-backup-request");
    const native = recordNativeCorrection(db, { ...validEvent(), connector_id: "kizuki.owner",
      source_record_id: request, text: "KIZUKI CONTEXT v1 intentional owner statement" }, request);
    rmSync(backup, { recursive: true });
    exportVault(db, vault, backup);
    const target = join(temporary("kizuki-backup-native-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(readSince(restored, null, 10).events.find(row => row.event_id === native.event_id)?.origin).toBe("external");
      expect(accept(restored, { ...validEvent(), connector_id: "kizuki.owner", source_record_id: "forged-label",
        text: "KIZUKI CONTEXT v1 intentional owner statement" })).toMatchObject({ status: "stored", event: { origin: "self" } });
    } finally { restored.close(); }
    const manifest = readManifest(backup);
    const proof = JSON.parse(readFileSync(join(backup, "ledger/native_owner_evidence.jsonl"), "utf8")) as Record<string, unknown>;
    proof.event_id = readSince(db, null, 1).events[0]!.event_id;
    writeJsonl(backup, manifest, "ledger/native_owner_evidence.jsonl", [proof]);
    signManifest(backup, manifest);
    const invalidTarget = join(temporary("kizuki-backup-native-forged-"), "vault");
    expect(() => restoreVault(backup, invalidTarget)).toThrow();
    expect(existsSync(invalidTarget)).toBe(false);
  } finally { db.close(); }
});

test.each(["transferred event", "changed binding", "missing binding", "changed timestamp"])(
  "refuses a re-signed native proof with %s", (mutation) => {
    const { backup, db, vault } = fixture();
    try {
      const request = sha256Hex("native-proof-binding-request");
      recordNativeCorrection(db, { ...validEvent(), connector_id: "kizuki.owner", source_record_id: request }, request);
      const captured = accept(db, { ...validEvent(), connector_id: "kizuki.owner", source_record_id: "same-time-captured-owner-label" });
      if (captured.status !== "stored") throw new Error("fixture failed");
      rmSync(backup, { recursive: true });
      exportVault(db, vault, backup);
      const manifest = readManifest(backup);
      const proof = JSON.parse(readFileSync(join(backup, "ledger/native_owner_evidence.jsonl"), "utf8")) as Record<string, unknown>;
      if (mutation === "transferred event") proof.event_id = captured.event.event_id;
      if (mutation === "changed binding") proof.event_content_hash = "b".repeat(64);
      if (mutation === "missing binding") delete proof.event_content_hash;
      if (mutation === "changed timestamp") proof.recorded_at = "2030-01-01T00:00:00Z";
      writeJsonl(backup, manifest, "ledger/native_owner_evidence.jsonl", [proof]);
      signManifest(backup, manifest);
      const target = join(temporary("kizuki-backup-invalid-native-binding-"), "vault");
      expect(() => restoreVault(backup, target)).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally { db.close(); }
  },
);

test("explicit legacy restore binds an original native proof to its unchanged v1 event hash", () => {
  const { backup, db, vault } = fixture();
  try {
    db.query("DELETE FROM events").run();
    const request = sha256Hex("legacy-native-request");
    const input = { ...validEvent(), connector_id: "kizuki.owner", source_record_id: request,
      text: "KIZUKI CONTEXT v1 deliberate legacy owner correction" };
    recordNativeCorrection(db, input, request);
    rmSync(backup, { recursive: true });
    exportVault(db, vault, backup);
    const manifest = readManifest(backup);
    const current = onlyEvent(backup);
    const { content_hash_version: _version, text_hash: _textHash, origin: _origin, ...legacy } = current;
    legacy.content_hash = computeLegacyContentHash(input);
    const proof = JSON.parse(readFileSync(join(backup, "ledger/native_owner_evidence.jsonl"), "utf8")) as Record<string, unknown>;
    delete proof.event_content_hash;
    writeJsonl(backup, manifest, "ledger/events.jsonl", [legacy]);
    writeJsonl(backup, manifest, "ledger/native_owner_evidence.jsonl", [proof]);
    unlinkSync(join(backup, "ledger/canon-machine-byte-intents.jsonl"));
    delete manifest.files["ledger/canon-machine-byte-intents.jsonl"];
    manifest.schema = LEGACY_BACKUP_SCHEMA;
    manifest.schema_versions = { ...manifest.schema_versions, ledger: 15 };
    signManifest(backup, manifest);
    const target = join(temporary("kizuki-backup-legacy-native-"), "vault");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(readSince(restored, null, 1).events[0]).toMatchObject({
        content_hash: legacy.content_hash, content_hash_version: 1, origin: "external",
      });
      expect(restored.query("SELECT event_content_hash FROM native_owner_evidence").get())
        .toEqual({ event_content_hash: legacy.content_hash });
    } finally { restored.close(); }
  } finally { db.close(); }
});
