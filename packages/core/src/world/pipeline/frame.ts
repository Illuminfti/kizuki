import type { ServeContext } from "../../serving/types";
import type { WorldValidQuery } from "../../serving/world-view";
import type { WorldNamespace } from "../references";
import { newReadStats, type ReadStats } from "./stats";

export class WorldProjectionBudgetError extends Error {}

/** Bytes of stored support one read may parse. */
export type ReadBudget = { bytes: number };
const READ_BYTE_LIMIT = 2 * 1024 * 1024;

export function charge(budget: ReadBudget, value: string): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > READ_BYTE_LIMIT) throw new WorldProjectionBudgetError();
}

/**
 * Which recorded past a read is served from. Only the present is servable, so
 * a `knownAt` time or snapshot is refused before a frame exists. Known-at
 * history widens this type and `claimVisibleSql`, the one place the collect
 * stage names a claim status in SQL. `eligibleWorldClaim` checks the status
 * of the row it loads and moves with it.
 */
export type RecordedCutoff = { readonly kind: "current" };

/** Everything one read carries through collect, enrich, group and assemble. */
export interface ReadFrame {
  readonly ctx: ServeContext;
  readonly ns: WorldNamespace;
  readonly valid: WorldValidQuery;
  readonly cutoff: RecordedCutoff;
  readonly budget: ReadBudget;
  readonly stats: ReadStats;
}

let sink: ReadFrame[] | null = null;

export function newReadFrame(
  ctx: ServeContext,
  ns: WorldNamespace,
  valid: WorldValidQuery,
): ReadFrame {
  const frame: ReadFrame = {
    ctx,
    ns,
    valid,
    cutoff: { kind: "current" },
    budget: { bytes: 0 },
    stats: newReadStats(),
  };
  sink?.push(frame);
  return frame;
}

/** SQL true for a claim row (`alias`) as the frame's recorded cutoff sees it. */
export function claimVisibleSql(frame: ReadFrame, alias: string): string {
  switch (frame.cutoff.kind) {
    case "current":
      return `${alias}.status='live'`;
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
