import { CanonFilesError } from "../vault/canon-files";
import { VaultMutationError } from "../vault/mutation-scope";
import { CanonWriteRefused } from "../vault/write";
import { ReceiptStreamError } from "./receipt-stream";
import { CanonRecoveryError, type CanonRecoveryReason } from "./write-intent";

const FULL = new Set(["ENOSPC", "EDQUOT"]);
const REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);

/** The errno of a storage refusal anywhere in a bounded cause chain. */
function storageReason(error: unknown): CanonRecoveryReason | null {
  let cursor: unknown = error;
  for (let depth = 0; cursor instanceof Error && depth < 8; depth += 1, cursor = cursor.cause) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    if (FULL.has(code)) return "storage_full";
    if (REFUSED.has(code)) return "storage_refused";
  }
  return null;
}

/** The recovery boundary speaks only CanonRecoveryError, so every caller,
 * including the daemon, can hold a write instead of failing on it. Errors
 * this boundary cannot explain return null and keep their own type. */
export function asCanonRecoveryError(error: unknown, receiptId: string | null): CanonRecoveryError | null {
  if (error instanceof CanonRecoveryError) return error;
  const storage = storageReason(error);
  if (storage !== null) return new CanonRecoveryError(storage, receiptId, { cause: error });
  if (error instanceof VaultMutationError && error.code === "writer_busy") return new CanonRecoveryError("writer_busy", receiptId, { cause: error });
  if (error instanceof CanonWriteRefused) {
    const reason = error.reason === "stage_custody_unknown" ? "stage_custody_unknown" :
      error.reason === "archive_exists" ? "archive_changed" :
      ["page_changed", "page_exists", "page_missing"].includes(error.reason) ? "page_changed" : "write_refused";
    return new CanonRecoveryError(reason, receiptId, { cause: error });
  }
  if (error instanceof ReceiptStreamError) {
    return new CanonRecoveryError(error.reason === "changed" ? "receipt_stream_changed" : "receipt_stream_refused", receiptId, { cause: error });
  }
  if (error instanceof CanonFilesError) return new CanonRecoveryError("write_refused", receiptId, { cause: error });
  return null;
}
