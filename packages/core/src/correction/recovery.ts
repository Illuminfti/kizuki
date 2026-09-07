import type { Database } from 'bun:sqlite';
import { readCanonWriteIntent } from '../canon/write-intent';
import { readCanonProjectionObligation } from '../canon/projection-obligations';
import { assertPageRelPath } from '../canon/paths';
import type { CanonRecoveryPending } from './types';

/** Only an already authorized claim or resolved page may disclose its pending receipt. */
export function correctionRecoveryPending(db: Database, claimId: string, pagePath?: string): CanonRecoveryPending[] {
  if (pagePath !== undefined) assertPageRelPath(pagePath);
  const intent = readCanonWriteIntent(db);
  if (intent !== null && (pagePath === undefined
    ? intent.receipt.claim_ids.includes(claimId)
    : intent.receipt.page_path === pagePath)) {
    return [{ receipt_id: intent.receipt.receipt_id, page_path: intent.receipt.page_path, phase: 'write' }];
  }
  const rows = pagePath === undefined
    ? db.query<{ receipt_id: string }, [string]>(`SELECT p.receipt_id FROM canon_projection_obligations p
        JOIN claims c ON c.receipt_id=p.receipt_id WHERE c.claim_id=? LIMIT 1`).all(claimId)
    : db.query<{ receipt_id: string }, [string]>('SELECT receipt_id FROM canon_projection_obligations WHERE page_path=? ORDER BY receipt_id LIMIT 25').all(pagePath);
  return rows.flatMap(row => {
    const saved = readCanonProjectionObligation(db, row.receipt_id);
    return saved === null ? [] : [{ receipt_id: row.receipt_id, page_path: saved.value.receipt.page_path, phase: 'projection' as const }];
  });
}
