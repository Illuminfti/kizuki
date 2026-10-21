import { lastStateSql, type KnownCutoff } from "../known/cutoff";
import type { ServeContext } from "../../serving/types";
import type { WorldValidQuery } from "../../serving/world-view";
import type { WorldDependencies } from "../dependencies";
import type { WorldNamespace } from "../references";
import { newReadStats, type ReadStats } from "./stats";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./eligible";

export class WorldProjectionBudgetError extends Error {}
/** The public request exhausted its shared candidate allowance. */
export class WorldClaimBudgetError extends WorldProjectionBudgetError {}

/** Bytes of stored support one read may parse. */
export type ReadBudget = {
  bytes: number;
  /** Public world requests share this count across discovery, cards and child reads.
   * Byte-only internal consumers retain their existing per-card limits. */
  claimVerifications?: number;
  /** Reset at the start of each projection. Only reused inside its transaction. */
  verifiedClaims?: WeakMap<Database, Map<string, Eligible | null>>;
};
export const WORLD_CLAIM_VERIFICATION_LIMIT = 129; // 128 candidates plus an overflow sentinel.
const READ_BYTE_LIMIT = 2 * 1024 * 1024;

export function charge(budget: ReadBudget, value: string): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > READ_BYTE_LIMIT) throw new WorldProjectionBudgetError();
}

/** Current state or a private exact committed history cutoff. */
export type RecordedCutoff = { readonly kind: "current" } | ({ readonly kind: "recorded" } & KnownCutoff);

/** Everything one read carries through collect, enrich, group and assemble. */
export interface ReadFrame {
  readonly ctx: ServeContext;
  readonly ns: WorldNamespace;
  readonly valid: WorldValidQuery;
  readonly cutoff: RecordedCutoff;
  /** Host-captured current session evaluation; never taken from a world_view argument. */
  readonly currentOutcomeAt?: string;
  /** Internal session projection: qualified recorded relations, not a full card or summary. */
  readonly projection?: "relations";
  readonly budget: ReadBudget;
  readonly stats: ReadStats;
  /** A traversed member may have a retained baseline even when the anchor has full history. */
  historyBaseline: boolean;
  readonly dependencies?: WorldDependencies | undefined;
}

let sink: ReadFrame[] | null = null;

export function newReadFrame(
  ctx: ServeContext,
  ns: WorldNamespace,
  valid: WorldValidQuery,
  dependencies?: WorldDependencies,
  cutoff: RecordedCutoff = { kind: "current" },
): ReadFrame {
  const frame: ReadFrame = {
    ctx,
    ns,
    valid,
    cutoff,
    budget: ctx.worldReadBudget ?? { bytes: 0 },
    stats: newReadStats(),
    historyBaseline: false,
    dependencies,
  };
  sink?.push(frame);
  return frame;
}

/** SQL true for a claim row (`alias`) as the frame's recorded cutoff sees it. */
export function claimVisibleSql(frame: ReadFrame, alias: string): string {
  switch (frame.cutoff.kind) {
    case "current":
      return `${alias}.status='live'`;
    case "recorded":
      return `${alias}.status<>'purged' AND ${lastStateSql(frame.cutoff, `${alias}.claim_id`)}='live'`;
  }
}

/**
 * TEST ONLY. Runs `run` and returns every frame it opened, so a test can read
 * the work counters of any world read through its public seam. It does not
 * nest and it is not part of the package surface.
 */
export function collectReadFrames<T>(run: () => T): {
  result: T;
  frames: readonly ReadFrame[];
} {
  if (sink !== null) throw new Error("collectReadFrames cannot nest");
  const frames: ReadFrame[] = [];
  sink = frames;
  try {
    return { result: run(), frames };
  } finally {
    sink = null;
  }
}
