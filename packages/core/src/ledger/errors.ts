export const LEDGER_STORE_ERROR_CODES = [
  "usage",
  "busy",
  "infrastructure",
  "corrupt",
] as const;

export type LedgerStoreErrorCode = (typeof LEDGER_STORE_ERROR_CODES)[number];

/**
 * Failures at the ledger store seam. Record validation stays on `accept`'s
 * `{ status: "error", kind: "validation" }` result. This type is for
 * infrastructure, corruption, and caller-usage mistakes that must not be
 * represented as a bad record.
 */
export class LedgerStoreError extends Error {
  override readonly name = "LedgerStoreError";
  readonly code: LedgerStoreErrorCode;
  readonly retryable: boolean;

  constructor(
    code: LedgerStoreErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options?.retryable ?? code === "busy";
  }
}

export function isLedgerStoreError(error: unknown): error is LedgerStoreError {
  return error instanceof LedgerStoreError;
}

export function classifySqliteFailure(error: unknown): LedgerStoreError | null {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const text = error instanceof Error ? error.message : String(error);
  const haystack = `${code} ${text}`;
  if (/SQLITE_BUSY|SQLITE_LOCKED/.test(haystack)) {
    return new LedgerStoreError("busy", "ledger is busy", { retryable: true, cause: error });
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed/.test(haystack)) {
    return new LedgerStoreError("corrupt", "ledger is corrupt", { cause: error });
  }
  const infra = haystack.match(
    /SQLITE_(IOERR|FULL|CANTOPEN|READONLY|NOMEM|PROTOCOL|NOLFS|MISUSE|RANGE)[A-Z0-9_]*/,
  );
  if (infra !== null) {
    return new LedgerStoreError(
      "infrastructure",
      `ledger store is unavailable (${infra[0]})`,
      {
        retryable: /SQLITE_IOERR|SQLITE_FULL/.test(infra[0]),
        cause: error,
      },
    );
  }
  return null;
}
