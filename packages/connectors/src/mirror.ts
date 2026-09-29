/**
 * Shared rules for connectors that mirror a tree the owner edits: a record's
 * state can change without its bytes being new, and a record can change name.
 */

/** What the ledger holds about one source record, supplied by the host. */
export interface RecordHistory {
  /** Every event the source has for the record, tombstones included. */
  readonly events: number;
  /**
   * The mirror no longer counts the record as present: its latest event is a
   * tombstone, or a later event moved it to another name.
   */
  readonly withdrawn: boolean;
}

export type RecordHistoryReader = (
  relpaths: readonly string[],
) => ReadonlyMap<string, RecordHistory> | Promise<ReadonlyMap<string, RecordHistory>>;

const HISTORY_CHUNK = 256;

/**
 * The `revision_epoch` for events about to be emitted. The ledger dedupes an
 * event whose content it has stored before, so bytes that return after a
 * deletion or an edit would vanish; an epoch that grows with the record's
 * history makes each change of state a new event, while a record the ledger
 * already holds unchanged is not emitted at all.
 *
 * A record with prior events that is neither withdrawn nor a known changed
 * file (a page the planner could not place, say) keeps epoch zero, so the
 * ledger keeps deduping its repeats.
 */
export class EpochReader {
  readonly #epochs = new Map<string, number>();

  constructor(
    private readonly read: RecordHistoryReader | undefined,
  ) {}

  async of(
    relpaths: readonly string[],
    index: number,
    hasIdentity: (relpath: string) => boolean,
  ): Promise<number> {
    if (this.read === undefined) return 0;
    const relpath = relpaths[index]!;
    if (!this.#epochs.has(relpath)) {
      const chunk = relpaths.slice(index, index + HISTORY_CHUNK);
      const found = await this.read(chunk);
      for (const item of chunk) {
        const history = found.get(item);
        this.#epochs.set(
          item,
          history !== undefined && (history.withdrawn || hasIdentity(item))
            ? history.events
            : 0,
        );
      }
    }
    return this.#epochs.get(relpath) ?? 0;
  }
}

/** A record named with the digest of its bytes. */
export interface MoveName {
  readonly relpath: string;
  readonly hash: string;
}

/**
 * New names whose bytes match exactly one name that is gone. Anything less
 * exact stays a withdrawal plus a new file: guessing a move wrongly would
 * hand one record's history to another. Empty files never pair.
 */
export function pairMoves(
  added: readonly (MoveName & { readonly size: number })[],
  gone: readonly MoveName[],
): Map<string, string> {
  const goneByHash = new Map<string, string[]>();
  for (const item of gone) {
    if (item.hash === "") continue;
    goneByHash.set(item.hash, [...(goneByHash.get(item.hash) ?? []), item.relpath]);
  }
  const addedByHash = new Map<string, string[]>();
  for (const item of added) {
    if (item.size === 0 || item.hash === "") continue;
    addedByHash.set(item.hash, [...(addedByHash.get(item.hash) ?? []), item.relpath]);
  }
  const moves = new Map<string, string>();
  for (const [hash, names] of addedByHash) {
    const origins = goneByHash.get(hash);
    if (names.length === 1 && origins?.length === 1) {
      moves.set(names[0]!, origins[0]!);
    }
  }
  return moves;
}
