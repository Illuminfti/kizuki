import type { WorldKindSpec } from "../../contracts/world-kinds";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { KIND_ASSEMBLERS } from "../kinds";
import type { AssembledCard, KindAssembler } from "../kinds/kit";
import {
  assembleCard,
  assembleMatches,
  type WorldMatches,
} from "./assemble";
import {
  COLLECTORS,
  collectCard,
  scanMatches,
  type Collector,
} from "./collect";
import { enrich, type Enricher } from "./enrich";
import { ENRICHERS } from "./enrichers";
import type { ReadFrame } from "./frame";
import { GROUPERS, group, type Grouper } from "./group";

/** The lists every read walks, in the order they run. */
export interface PipelineStages {
  readonly groupers: readonly Grouper[];
  readonly collectors: readonly Collector[];
  readonly enrichers: readonly Enricher[];
  readonly assemblers: readonly KindAssembler[];
}

const SHIPPED: PipelineStages = Object.freeze({
  groupers: GROUPERS,
  collectors: COLLECTORS,
  enrichers: ENRICHERS,
  assemblers: KIND_ASSEMBLERS,
});
let active: PipelineStages = SHIPPED;

/**
 * TEST ONLY. Runs `run` with `extra` appended to the shipped stage lists, then
 * restores them. The lists are process-wide, so one use at a time: entering
 * while another use is still running throws. It is not part of the package
 * surface and no production code calls it.
 */
export function withWorldPipeline<T>(
  extra: { [Stage in keyof PipelineStages]?: PipelineStages[Stage] },
  run: () => T,
): T {
  if (active !== SHIPPED)
    throw new Error("withWorldPipeline is sequential-only: another use is still running");
  active = Object.freeze({
    groupers: [...GROUPERS, ...(extra.groupers ?? [])],
    collectors: [...COLLECTORS, ...(extra.collectors ?? [])],
    enrichers: [...ENRICHERS, ...(extra.enrichers ?? [])],
    assemblers: [...KIND_ASSEMBLERS, ...(extra.assemblers ?? [])],
  });
  const restore = () => {
    active = SHIPPED;
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

function kindSpec(kindId: string): WorldKindSpec {
  const kind = activeWorldRegistry().kind(kindId);
  if (kind === undefined) throw new Error(`world kind ${kindId} is not registered`);
  return kind;
}

/**
 * The card of the handle as `kindId`, or null when the handle is unknown, is
 * not classified as that kind for this reader, or the kind has no card.
 */
export function readWorldCard(
  frame: ReadFrame,
  handle: string,
  kindId: string,
): AssembledCard | null {
  const kind = kindSpec(kindId);
  const stages = active;
  const assembler = stages.assemblers.find((one) => one.kind === kind.id);
  if (assembler === undefined) return null;
  const cluster = group(frame, handle, stages.groupers);
  const collection = collectCard(frame, cluster, kind, stages.collectors);
  if (collection === null) return null;
  const body = enrich(frame, collection.items, stages.enrichers);
  return assembleCard(frame, kind, assembler, cluster, collection, body);
}

/** One page of handles of `kindId` whose label contains `label`, after the handle `after` when given. */
export function readWorldMatches<KindId extends string>(
  frame: ReadFrame,
  kindId: KindId,
  label: string,
  after: string | null,
  scanBudget: number,
): WorldMatches<`kizuki.${KindId}-matches/v1`> {
  const kind = kindSpec(kindId);
  const scan = scanMatches(frame, kind, label, after, scanBudget);
  return assembleMatches(frame, `kizuki.${kindId}-matches/v1`, kind, scan, after === null);
}
