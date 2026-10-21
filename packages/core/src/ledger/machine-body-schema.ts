import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "../world/tables/registry";
import { WORLD_MIGRATION_VERSIONS } from "../world/tables/versions";

/** Hashes remain tied to a retained loop receipt or its unpublished byte intent. */
export function applyMachineBodies(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canon_machine_body_images (
      receipt_id TEXT NOT NULL CHECK(length(receipt_id)=26 AND receipt_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'),
      image_hash TEXT NOT NULL CHECK(length(image_hash)=64 AND image_hash NOT GLOB '*[^0-9a-f]*'),
      body_hash TEXT NOT NULL CHECK(length(body_hash)=64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
      PRIMARY KEY(receipt_id,image_hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS canon_machine_body_hash ON canon_machine_body_images(body_hash);
    CREATE TRIGGER IF NOT EXISTS canon_body_receipt_changed AFTER UPDATE OF before_hash,after_hash,writer ON canon_receipts BEGIN
      DELETE FROM canon_machine_body_images WHERE receipt_id=OLD.receipt_id
        AND (NEW.writer!='loop' OR (image_hash IS NOT NEW.before_hash AND image_hash IS NOT NEW.after_hash));
    END;
    CREATE TRIGGER IF NOT EXISTS canon_body_receipt_deleted AFTER DELETE ON canon_receipts BEGIN
      DELETE FROM canon_machine_body_images WHERE receipt_id=OLD.receipt_id
        AND NOT EXISTS(SELECT 1 FROM canon_machine_byte_intents i WHERE i.receipt_id=OLD.receipt_id);
    END;
    CREATE TRIGGER IF NOT EXISTS canon_body_intent_deleted AFTER DELETE ON canon_machine_byte_intents BEGIN
      DELETE FROM canon_machine_body_images WHERE receipt_id=OLD.receipt_id
        AND NOT EXISTS(SELECT 1 FROM canon_receipts r WHERE r.receipt_id=OLD.receipt_id AND r.writer='loop'
          AND (r.before_hash=image_hash OR r.after_hash=image_hash));
    END;
  `);
}

export const MACHINE_BODY_TABLE: WorldTableSpec = {
  name: "canon_machine_body_images", class: "bookkeeping",
  since: WORLD_MIGRATION_VERSIONS.machine_images,
  columns: ["receipt_id", "image_hash", "body_hash"], create: applyMachineBodies,
  erasure: { via: "trigger", triggers: ["canon_body_receipt_changed", "canon_body_receipt_deleted", "canon_body_intent_deleted"] },
};

/** Backup rows cannot invent a machine image without its exact receipt or intent. */
export function assertMachineBodyBindings(db: Database): void {
  if (db.query(`SELECT 1 FROM canon_machine_body_images b WHERE
      NOT EXISTS(SELECT 1 FROM canon_receipts r WHERE r.receipt_id=b.receipt_id AND r.writer='loop'
        AND (r.before_hash=b.image_hash OR r.after_hash=b.image_hash))
      AND NOT EXISTS(SELECT 1 FROM canon_machine_byte_intents i WHERE i.receipt_id=b.receipt_id
        AND (i.before_hash=b.image_hash OR i.after_hash=b.image_hash)) LIMIT 1`).get() !== null) {
    throw new Error("machine body registry is invalid");
  }
}
