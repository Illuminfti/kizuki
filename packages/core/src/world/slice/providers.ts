import type { Relation, ViewGap } from "../../contracts/world-card-kit";
import type { SliceItem, ProviderCoverage } from "../../contracts/world-slice";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { isPlainObject } from "../../util/validate";
import { KIND_ASSEMBLERS } from "../kinds";
import { populationEnabled } from "../pipeline/assemble";
import { WORLD_DISCOVERY_SCAN_BUDGET } from "../pipeline/collect";
import { newReadFrame } from "../pipeline/frame";
import { readWorldCard, readWorldMatches } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import type { WorldFrame, WorldWhen } from "../ops/types";
import type { WorldWireRef } from "../../contracts/world-card-kit";
import type { KindAssembler } from "../kinds/kit";
import { sourceCoverage } from "../coverage";
import { createRedactor } from "../../serving/redact";
import { relevantMatches } from "./relevance";

export interface SliceCandidates {
  readonly constraints: readonly SliceItem[];
  readonly detail: readonly SliceItem[];
  readonly providers: readonly ProviderCoverage[];
  readonly gaps: readonly ViewGap[];
  readonly truncated: boolean;
}

/** Walk only an already authorized, byte-bounded card; retain each qualified assertion once. */
export function projectedRelations(card: unknown): readonly Relation[] {
  const pending = [card], found = new Map<string, Relation>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!isPlainObject(value)) continue;
    if (value.schema === "kizuki.relation/v1") {
      const item = value as unknown as Relation;
      found.set(item.claim.token, item);
    } else pending.push(...Object.values(value));
  }
  return [...found.values()].sort((a, b) => a.claim.token.localeCompare(b.claim.token));
}

/** Reused for public task views and selected session cards; never re-reads a claim. */
export function cardSliceItems(kind: string, node: WorldWireRef<"object">, card: unknown, assembler: KindAssembler) {
  const constraints: SliceItem[] = [], detail: SliceItem[] = [];
  for (const relation of projectedRelations(card)) {
    const evidence = [...new Map([...relation.perspective.evidence, ...relation.assessments.flatMap(one => one.evidence)]
      .map(one => [JSON.stringify(one), one])).values()];
    const item: SliceItem = { kind, node, relation, evidence };
    const required = assembler.sliceConstraint?.(relation) === true || relation.polarity === "negative" || relation.conflict !== "none_observed" ||
      relation.perspective.mode !== "asserted" || relation.perspective.interpretation !== "explicit";
    (required ? constraints : detail).push(item);
  }
  return { constraints, detail };
}

export function sliceAssembler(kind: string) {
  return KIND_ASSEMBLERS.find(one => one.kind === kind && one.cardSchema !== undefined) ?? KIND_ASSEMBLERS.find(one => one.kind === kind);
}

/** One bounded source of candidates for the public slice and session-start renderer. */
export function collectSlice(frame: WorldFrame, kinds: readonly string[], when: WorldWhen, task = ""): SliceCandidates {
  const constraints: SliceItem[] = [], detail: SliceItem[] = [], providers: ProviderCoverage[] = [];
  const gaps = new Set<ViewGap>(sourceCoverage(frame.ctx, frame.dependencies));
  const read = newReadFrame(frame.ctx, frame.ns, when.valid, frame.dependencies);
  const preview = createRedactor(frame.ctx.principal, frame.ctx.servingSecrets);
  let truncated = false;
  for (const id of [...kinds].sort()) {
    const kind = activeWorldRegistry().kind(id), assembler = sliceAssembler(id);
    if (kind === undefined || assembler?.sliceConstraint === undefined) {
      providers.push({ kind: id, status: "unavailable", reason: "not_landed" }); gaps.add("coverage"); continue;
    }
    if (!populationEnabled(kind)) {
      providers.push({ kind: id, status: "unavailable", reason: "extraction_off" }); gaps.add("coverage");
    } else providers.push({ kind: id, status: "included" });
    const matches = readWorldMatches(read, id, "", null, WORLD_DISCOVERY_SCAN_BUDGET);
    for (const gap of matches.coverage.gaps) gaps.add(gap);
    // Discovery records every examined authorized label/classification in the
    // dependency closure, including candidates that relevance does not select.
    const selected = relevantMatches(matches.matches, task, preview);
    if (matches.cursor !== null || selected.length > 4) { truncated = true; gaps.add("traversal_limit"); }
    for (const match of selected.slice(0, 4)) {
      const handle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
      const card = handle === null ? null : readWorldCard(read, handle, id, assembler.cardSchema);
      if (card === null) continue;
      for (const gap of card.coverage.gaps) gaps.add(gap);
      const items = cardSliceItems(id, match.ref, card, assembler);
      constraints.push(...items.constraints); detail.push(...items.detail);
    }
  }
  return { constraints, detail, providers, gaps: [...gaps], truncated };
}
