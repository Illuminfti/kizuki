import { conceptOp } from "./concept";
import { describeOp } from "./describe";
import { discoverConceptsOp, discoverSituationsOp } from "./discover";
import { situationOp } from "./situation";
import { shareOp } from "./share";
import { resumeOp } from "./resume";
import type { WorldOp, WorldOpRegistry } from "./types";

const COMMON_KEYS = ["operation", "valid", "knownAt", "priorView"];

function assertWorldOp(op: WorldOp): void {
  const label = `world operation "${op.name}"`;
  if (!/^[a-z][a-z0-9_]*$/.test(op.name))
    throw new Error(`${label}: the name must be lower snake case`);
  if (
    op.dataSchemas.length === 0 ||
    op.dataSchemas.some((id) => typeof id !== "string" || id === "")
  )
    throw new Error(`${label}: declare the data schema id of every result`);
  if (typeof op.run !== "function") throw new Error(`${label}: run is missing`);
  if (op.source === "build") return;
  if (typeof op.parse !== "function")
    throw new Error(`${label}: parse is missing`);
  const { required, optional } = op.keys;
  for (const key of [...required, ...optional])
    if (COMMON_KEYS.includes(key))
      throw new Error(`${label}: "${key}" is a common key the reader owns`);
  if (new Set([...required, ...optional]).size !== required.length + optional.length)
    throw new Error(`${label}: a key is declared twice`);
}

/**
 * An operation defined in terms of the others, such as `resume`, which answers
 * with the body of whichever object read was shared. It is handed the plain
 * operations of the same registry, so a kind that registers later is included.
 */
export type WorldOpFactory = (registered: readonly WorldOp[]) => WorldOp;
export type WorldOpSource = WorldOp | WorldOpFactory;

/** The one place a registry is validated: each operation is whole, and no name repeats. */
export function worldOpRegistry(sources: readonly WorldOpSource[]): WorldOpRegistry {
  const plain = sources.filter((source): source is WorldOp => typeof source !== "function");
  const ops = sources.map((source) => (typeof source === "function" ? source(plain) : source));
  const seen = new Set<string>();
  for (const op of ops) {
    assertWorldOp(op);
    if (seen.has(op.name))
      throw new Error(`world operation "${op.name}" is registered twice (duplicate name)`);
    seen.add(op.name);
  }
  return Object.freeze(ops);
}

export function findWorldOp(
  registry: WorldOpRegistry,
  name: unknown,
): WorldOp | undefined {
  return registry.find((op) => op.name === name);
}

/** Explicit list; a workstream adds its operation on the line under its own marker. */
const WORLD_OP_SOURCES: readonly WorldOpSource[] = [
  discoverConceptsOp,
  discoverSituationsOp,
  conceptOp,
  situationOp,
  describeOp,
  // slot: CARD
  // slot: KNOWN
  // slot: VIEW
  shareOp, resumeOp,
  // slot: QUEST
  // slot: PEOPLE
  // slot: SKILL
  // slot: ART
  // slot: OUTCOME
  // slot: DIFF
  // slot: SLICE
  // slot: ATTN
  // slot: FCST
  // slot: ATLAS
];

export const WORLD_OPS: WorldOpRegistry = worldOpRegistry(WORLD_OP_SOURCES);

let active: WorldOpRegistry = WORLD_OPS;

/** The registry every reader, host and adapter in this process consults. */
export function activeWorldOps(): WorldOpRegistry {
  return active;
}

/**
 * Test seam, exported only through `@kizuki/core/testing`: runs `run` with
 * `extra` registered beside the shipped operations, then restores the shipped
 * registry. The registry is process-wide, so one use at a time: entering while
 * another use is still running throws instead of restoring out of order. A test
 * that awaits it (no `test.concurrent`) is always sequential.
 */
export function withWorldOps<T>(extra: readonly WorldOp[], run: () => T): T {
  if (active !== WORLD_OPS)
    throw new Error("withWorldOps is sequential-only: another use is still running");
  active = worldOpRegistry([...WORLD_OP_SOURCES, ...extra]);
  const restore = () => {
    active = WORLD_OPS;
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
