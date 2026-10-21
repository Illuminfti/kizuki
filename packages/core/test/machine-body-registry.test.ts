import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { commitMachineByteIntent } from "../src/ledger/event-origin";
import { accept } from "../src/ledger/ledger";
import { machineBodyHash } from "../src/ledger/machine-image";
import { WORLD_MIGRATION_VERSIONS } from "../src/world/tables/versions";
import { sha256Hex } from "../src/util/hash";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

const page = "---\ntitle: Orchard\n---\nOrchard volunteers shelve books.\n";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a fresh registry atomically admits bodies and discards withdrawn intents", () => {
  const db = openLedger(":memory:");
  try {
    const intent = { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(page) };
    expect(() => commitMachineByteIntent(db, intent, () => { throw new Error("interrupted"); }, { before: null, after: page })).toThrow("interrupted");
    expect(db.query("SELECT 1 FROM canon_machine_body_images").get()).toBeNull();
    expect(db.query("SELECT 1 FROM canon_machine_byte_intents").get()).toBeNull();
    commitMachineByteIntent(db, intent, () => {}, { before: null, after: page });
    expect(accept(db, { ...validEvent(), text: "Orchard volunteers shelve books." })).toMatchObject({ status: "stored", event: { origin: "self" } });
    db.query("DELETE FROM canon_machine_byte_intents WHERE receipt_id=?").run(intent.receipt_id);
    expect(db.query("SELECT 1 FROM canon_machine_body_images").get()).toBeNull();
    expect(accept(db, { ...validEvent(), source_record_id: "after-withdrawal", text: "Orchard volunteers shelve books." })).toMatchObject({ status: "stored", event: { origin: "external" } });
  } finally { db.close(); }
});

test("image bytes must match the durable byte intent", () => {
  const db = openLedger(":memory:");
  try {
    expect(() => commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(page) }, () => {}, { before: null, after: "different" })).toThrow("event origin is unavailable");
    expect(db.query("SELECT 1 FROM canon_machine_body_images").get()).toBeNull();
  } finally { db.close(); }
});

test("upgrade from the previous ledger adds the registry without restamping prior captures", () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-body-upgrade-")); directories.push(directory);
  const path = join(directory, "ledger.db");
  const old = openLedger(path);
  const recorded = accept(old, { ...validEvent(), text: "Orchard volunteers shelve books." });
  const priorVersion = WORLD_MIGRATION_VERSIONS.machine_images - 1;
  old.exec("DROP TRIGGER canon_body_receipt_changed; DROP TRIGGER canon_body_receipt_deleted; DROP TRIGGER canon_body_intent_deleted; DROP TABLE canon_machine_body_images;");
  old.query("UPDATE schema_version SET version=?").run(priorVersion);
  old.close();
  const upgraded = openLedger(path);
  try {
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: WORLD_MIGRATION_VERSIONS.machine_images });
    expect(upgraded.query("SELECT 1 FROM canon_machine_body_images").get()).toBeNull();
    commitMachineByteIntent(upgraded, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(page) }, () => {}, { before: null, after: page });
    expect(upgraded.query("SELECT body_hash FROM canon_machine_body_images").get()).toEqual({ body_hash: machineBodyHash(page) });
    expect(recorded).toMatchObject({ status: "stored", event: { origin: "external" } });
    expect(accept(upgraded, { ...validEvent(), source_record_id: "after-upgrade", text: "Orchard volunteers shelve books." })).toMatchObject({ status: "stored", event: { origin: "self" } });
  } finally { upgraded.close(); }
});
