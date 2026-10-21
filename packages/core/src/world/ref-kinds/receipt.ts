import { getCanonReceipt, isErasedReceipt, type CanonReceipt } from "../../canon/receipts";
import type { ReceiptRef, ScopedRef } from "../../contracts/scoped-refs";
import { eventIdFromReference } from "../../retrieval/ids";
import { readableClaim } from "./claim";
import { allocateRef, readableEvent, ref, type RefScope } from "./common";

function readableReceipt(scope: RefScope, id: string): CanonReceipt | null {
  // Receipt refs are attribution only. Complete retained evidence must still be
  // readable; a receipt never makes its source or a page accessible.
  const row = scope.ctx.db.query<{ receipt_state: string }, [string]>("SELECT receipt_state FROM canon_receipts WHERE receipt_id=?").get(id);
  if (row === null || row.receipt_state === "erased") return null;
  const receipt = getCanonReceipt(scope.ctx.db, id);
  if (receipt === null || isErasedReceipt(receipt) || receipt.provenance.length === 0 || receipt.provenance.length > 64 ||
    receipt.provenance.some(source => !readableEvent(scope, eventIdFromReference(source))) ||
    receipt.claim_ids.some(claim => readableClaim(scope, claim) === null)) return null;
  return receipt;
}
export function issueReceiptRef(scope: RefScope, id: string): ReceiptRef | null {
  if (readableReceipt(scope, id) === null) return null;
  const existing = scope.ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_receipt_targets WHERE namespace_id=? AND receipt_id=?").get(scope.ns.id, id);
  if (existing !== null) return ref("receipt", existing.wire_ref);
  const token = allocateRef(scope.ctx.db, scope.ns, "receipt");
  scope.ctx.db.query("INSERT INTO world_wire_receipt_targets(namespace_id,wire_ref,receipt_id) VALUES (?,?,?)").run(scope.ns.id, token, id);
  return ref("receipt", token);
}
export function resolveReceiptRef(scope: RefScope, value: ScopedRef): CanonReceipt | null {
  if (value.kind !== "receipt") return null;
  const row = scope.ctx.db.query<{ receipt_id: string }, [string, string]>("SELECT receipt_id FROM world_wire_receipt_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token);
  return row === null ? null : readableReceipt(scope, row.receipt_id);
}
