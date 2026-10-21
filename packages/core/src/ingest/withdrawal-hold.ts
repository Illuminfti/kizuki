import { getCheckpoint } from "../ledger/connections";
import type { Database } from "bun:sqlite";

/**
 * A source mirror follows the source, so a pass that would withdraw most of a
 * source is more likely an emptied, half-mounted or replaced root than an
 * owner who deleted thousands of records at once. Such a pass emits no
 * tombstones and reports this typed state instead; the owner releases it once
 * with `sync CONNECTOR --source KEY --confirm-withdrawals N`.
 */

/** A pass may always withdraw this many records. */
export const MASS_WITHDRAWAL_FLOOR = 20;
/** Past the floor, a pass may withdraw this share of the source's records. */
export const MASS_WITHDRAWAL_SHARE = 0.2;

export const MASS_WITHDRAWAL_STATE = "mass_withdrawal_held" as const;

/**
 * True when withdrawing `withdrawn` of `total` records is more than the
 * source's allowance and `confirmed` (the count the owner released) does not
 * cover it.
 */
export function massWithdrawalHeld(
  withdrawn: number,
  total: number,
  confirmed = 0,
): boolean {
  if (withdrawn <= confirmed) return false;
  return withdrawn > Math.max(MASS_WITHDRAWAL_FLOOR, total * MASS_WITHDRAWAL_SHARE);
}

/** The connector-reported detail for a held pass; counts only, never a path. */
export function massWithdrawalDetail(withdrawn: number, total: number): string {
  return `${MASS_WITHDRAWAL_STATE}: ${withdrawn} of ${total}`;
}

export interface MassWithdrawalHold {
  readonly state: typeof MASS_WITHDRAWAL_STATE;
  readonly withdrawn: number;
  readonly total: number;
}

const HOLD_DETAIL = /^mass_withdrawal_held: (\d{1,9}) of (\d{1,9})$/;

export function parseMassWithdrawalDetail(text: string): MassWithdrawalHold | null {
  const match = HOLD_DETAIL.exec(text);
  if (match === null) return null;
  return {
    state: MASS_WITHDRAWAL_STATE,
    withdrawn: Number(match[1]),
    total: Number(match[2]),
  };
}

/** The hold a source's most recent run ended on, or null when it did not. */
export function massWithdrawalHoldOf(
  db: Database,
  connector_id: string,
  source_key: string,
): MassWithdrawalHold | null {
  const errors = getCheckpoint(db, connector_id, source_key)?.last_result.errors ?? [];
  for (const error of errors) {
    const hold = parseMassWithdrawalDetail(error);
    if (hold !== null) return hold;
  }
  return null;
}
