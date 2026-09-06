export type CanonWriteErrorCode =
  | "claim_not_live"
  | "claim_unknown"
  | "claim_mismatch"
  | "batch_mismatch"
  | "batch_too_large"
  | "nothing_to_write"
  | "page_exists"
  | "page_required"
  | "page_missing"
  | "provenance_unresolved"
  | "frontmatter_reserved"
  | "frontmatter_conflict"
  | "frontmatter_invalid"
  | "page_type_invalid"
  | "target_invalid"
  | "writer_invalid"
  | "decision_stale";

export type UndoErrorCode =
  | "receipt_unknown"
  | "already_reverted"
  | "page_changed"
  | "archive_missing"
  | "not_undoable";

/** Stable, actionable, and never carries captured text. */
export class CanonWriteError extends Error {
  override readonly name = "CanonWriteError";

  constructor(
    readonly code: CanonWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Undo refusals. Messages are the exact CLI/TUI text. */
export class UndoError extends Error {
  override readonly name = "UndoError";

  constructor(
    readonly code: UndoErrorCode,
    message: string,
  ) {
    super(message);
  }
}
