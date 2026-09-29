import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { insertReceiptRow, upsertPageIndex } from "../../src/canon/store";
import type { CanonReceipt } from "../../src/canon/receipts";
import { accept } from "../../src/ledger/ledger";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { serializePage } from "../../src/vault/frontmatter";
import { hashBytes } from "../../src/vault/write";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";

export interface BulkPage {
  readonly id: string;
  readonly relPath: string;
  readonly sourceId: string;
}

/**
 * Many live pages, each with its own external source event, page bytes, receipt
 * row and page index row, in one transaction. The pages are exactly what one
 * receipted canon write leaves behind, without paying one write for each.
 */
export function seedLivePages(
  db: Database,
  vaultPath: string,
  count: number,
  options: { body?: (index: number) => string } = {},
): BulkPage[] {
  seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "bulk-page-fixture" }, {
    default_sensitivity: "public", sensitivity_floor: "public",
  });
  const pages: BulkPage[] = [];
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const result = accept(db, {
        ...validEvent(), connector_id: "fixture", source_record_id: `bulk-${index}`,
        text: `bulk source ${index}`, sensitivity_hint: "personal",
      });
      if (result.status !== "stored") throw new Error(`bulk source: ${result.status}`);
      const sourceId = result.event.event_id;
      const id = `fact:bulk-${index}`;
      const relPath = `facts/bulk-${index}.md`;
      const bytes = Buffer.from(serializePage({
        data: {
          id, title: `Bulk ${index}`, type: "fact", status: "active",
          sensitivity: "personal", taint: "clean", sources: [sourceId],
        },
        body: options.body?.(index) ?? `Bulk page ${index}.`,
      }));
      mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
      writeFileSync(join(vaultPath, relPath), bytes);
      const receipt: CanonReceipt = {
        receipt_id: ulid(), kind: "write", claim_ids: [], page_path: relPath, page_action: "create",
        before_hash: null, after_hash: hashBytes(bytes), archive_path: null, writer: "loop",
        producer: "model", model_ref: "fixture:synthetic", authority: "model_inference", confidence: 0.5,
        sensitivity: "personal", taint: "clean", provenance: [sourceId], superseded: [], candidates: [],
        retrieval_ops: [], reverts: null, reverted_by: null, at: "2026-01-01T00:00:00.000Z",
      };
      insertReceiptRow(db, receipt, "entity");
      upsertPageIndex(db, {
        page_id: id, rel_path: relPath, subject_key: null,
        last_receipt: receipt.receipt_id, last_hash: receipt.after_hash,
      });
      pages.push({ id, relPath, sourceId });
    }
  }).immediate();
  return pages;
}
