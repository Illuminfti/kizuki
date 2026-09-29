import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { CONVERSATION_EVENT_KINDS } from "../staging/budget";

/**
 * Earlier revisions filed one capture-note claim per message onto a single
 * `captures/<connector>/<day>` page. That page is recomposed from all of its
 * live claims on every write, so a busy day outgrows the canon page limit.
 * Messages are evidence for extraction now; these claims are closed out, not
 * deleted, and the reason stays on the claim.
 */
export const CAPTURE_FANOUT_SKIP_REASON = "message_capture_fanout" as const;

/** Frontmatter key holding a claim's skip reason. */
export const SKIP_REASON_KEY = "x-skip-reason";

const BATCH = 500;
/** One repair call closes at most this many claims; the next call takes the rest. */
export const CAPTURE_FANOUT_REPAIR_LIMIT = 10_000;

const KIND_LIST = CONVERSATION_EVENT_KINDS.map((kind) => `'${kind}'`).join(",");

/**
 * A capture note the deterministic floor filed for a conversational event:
 * the connector-day target `captures/<segment>[/<day>]`, the `source` page
 * type and the capture kind it quoted. Typed pages an event proposes for
 * itself carry the same capture kind but never target `captures/`.
 */
const CAPTURE_NOTE_WHERE = `kind = 'claim' AND producer = 'deterministic'
  AND json_extract(frontmatter, '$.type') = 'source'
  AND json_extract(frontmatter, '$."x-capture-kind"') IN (${KIND_LIST})
  AND target GLOB 'captures/[^/]*' AND target NOT GLOB 'captures/*/*/*'
  AND (target NOT GLOB 'captures/*/*'
       OR target GLOB 'captures/*/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;

const UNWRITTEN_NOTE_WHERE = `status = 'live' AND receipt_id IS NULL AND ${CAPTURE_NOTE_WHERE}`;

/** True for a claim the capture fan-out repair closed out. */
export function isCaptureFanoutSkip(claim: { readonly frontmatter: Readonly<Record<string, unknown>> }): boolean {
  return claim.frontmatter[SKIP_REASON_KEY] === CAPTURE_FANOUT_SKIP_REASON;
}

export interface CaptureFanoutCounts {
  /** Live capture notes for conversational events that no receipt has written. */
  readonly pending: number;
  /** Capture claims already closed out for their reason. */
  readonly skipped: number;
}

/** What doctor reports, kept apart from the unwritten claims a writer still owes. */
export function countCaptureFanout(db: Database): CaptureFanoutCounts {
  if (!tableExists(db, "claims")) return { pending: 0, skipped: 0 };
  const count = (where: string, ...binds: string[]): number =>
    db
      .query<{ n: number }, string[]>(
        `SELECT count(*) AS n FROM claims WHERE ${where}`,
      )
      .get(...binds)?.n ?? 0;
  return {
    pending: count(UNWRITTEN_NOTE_WHERE),
    skipped: count(
      `status = 'skipped' AND json_extract(frontmatter, '$."${SKIP_REASON_KEY}"') = ?`,
      CAPTURE_FANOUT_SKIP_REASON,
    ),
  };
}

/**
 * Closes out every live, unwritten capture note of a conversational event as
 * `skipped` with its reason. Withdrawn is how a claim leaves staging without a
 * receipt, so `retracted_at` is set and a later write pass does not revive it.
 * A claim a receipt has written is never touched, no canon page is created or
 * changed, and a second call finds nothing left to close.
 */
export function skipCaptureFanoutClaims(
  db: Database,
  at: string,
  limit: number = CAPTURE_FANOUT_REPAIR_LIMIT,
): number {
  if (!tableExists(db, "claims")) return 0;
  const select = db.query<{ claim_id: string }, [number]>(
    `SELECT claim_id FROM claims WHERE ${UNWRITTEN_NOTE_WHERE} ORDER BY claim_id LIMIT ?`,
  );
  const close = db.query(
    `UPDATE claims
        SET status = 'skipped', retracted_at = ?,
            frontmatter = json_set(frontmatter, '$."${SKIP_REASON_KEY}"', ?)
      WHERE claim_id = ? AND ${UNWRITTEN_NOTE_WHERE}`,
  );
  const mirror = tableExists(db, "proposals")
    ? db.query(
        "UPDATE proposals SET status = 'withdrawn' WHERE proposal_id = ? AND status = 'pending'",
      )
    : null;
  let skipped = 0;
  while (skipped < limit) {
    const ids = select.all(Math.min(BATCH, limit - skipped));
    const closed = db
      .transaction(() => {
        let changed = 0;
        for (const { claim_id } of ids) {
          const result = close.run(at, CAPTURE_FANOUT_SKIP_REASON, claim_id);
          if (result.changes > 0) mirror?.run(claim_id);
          changed += result.changes;
        }
        return changed;
      })
      .immediate();
    // A batch that changed nothing would select itself again.
    if (closed === 0) break;
    skipped += closed;
  }
  return skipped;
}
