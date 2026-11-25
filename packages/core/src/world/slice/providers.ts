import type { Relation, ViewGap } from "../../contracts/world-card-kit";
import type { SliceItem, ProviderCoverage } from "../../contracts/world-slice";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { isPlainObject } from "../../util/validate";
import { KIND_ASSEMBLERS } from "../kinds";
import { populationEnabled } from "../pipeline/assemble";
import { WORLD_DISCOVERY_SCAN_BUDGET } from "../pipeline/collect";
import { newReadFrame, WorldClaimBudgetError } from "../pipeline/frame";
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
  readonly labels?: ReadonlyMap<string, readonly string[]>;
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
export function collectSlice(frame: Pick<WorldFrame, "ctx" | "ns" | "dependencies">, kinds: readonly string[], when: WorldWhen, task = "", options: { projection?: "relations"; subjects?: readonly string[]; matchingOnly?: boolean } = {}): SliceCandidates {
  const constraintByClaim = new Map<string, SliceItem>(), detailByClaim = new Map<string, SliceItem>();
  const labels = new Map<string, readonly string[]>(), providers: ProviderCoverage[] = [];
  const gaps = new Set<ViewGap>(sourceCoverage(frame.ctx, frame.dependencies));
  const read = { ...newReadFrame(frame.ctx, frame.ns, when.valid, frame.dependencies),
    ...(options.projection === undefined ? {} : { projection: options.projection }) };
  const preview = createRedactor(frame.ctx.principal, frame.ctx.servingSecrets);
  let truncated = false;
  let exhausted = false;
  for (const id of [...kinds].sort()) {
    const kind = activeWorldRegistry().kind(id), assembler = sliceAssembler(id);
    if (kind === undefined || assembler?.sliceConstraint === undefined) {
      providers.push({ kind: id, status: "unavailable", reason: "not_landed" }); gaps.add("coverage"); continue;
    }
    if (!populationEnabled(kind)) {
      providers.push({ kind: id, status: "unavailable", reason: "extraction_off" }); gaps.add("coverage");
    } else providers.push({ kind: id, status: "included" });
    if (exhausted) continue;
    try {
      const matches = readWorldMatches(read, id, "", null, WORLD_DISCOVERY_SCAN_BUDGET, undefined, options.subjects);
      for (const gap of matches.coverage.gaps) gaps.add(gap);
      // Discovery keeps every examined authorized label/classification in the dependency closure.
      const selected = relevantMatches(matches.matches, task, preview, !options.matchingOnly);
      if (matches.cursor !== null || selected.length > 4) { truncated = true; gaps.add("traversal_limit"); }
      for (const match of selected.slice(0, 4)) {
        const handle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
        const card = handle === null ? null : readWorldCard(read, handle, id, assembler.cardSchema);
        if (card === null) continue;
        labels.set(match.ref.token, match.labels);
        for (const gap of card.coverage.gaps) gaps.add(gap);
        const items = cardSliceItems(id, match.ref, card, assembler);
        for (const item of items.constraints) {
          const token = item.relation.claim.token;
          if (!constraintByClaim.has(token)) {
            constraintByClaim.set(token, item);
            detailByClaim.delete(token);
          }
        }
        for (const item of items.detail) {
          const token = item.relation.claim.token;
          if (!constraintByClaim.has(token) && !detailByClaim.has(token)) {
            detailByClaim.set(token, item);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof WorldClaimBudgetError)) throw error;
      // The unfinished card contributes no partial relations or qualifiers.
      // Keep completed units, disclose the traversal gap, and list later providers.
      exhausted = true; truncated = true; gaps.add("traversal_limit");
    }
  }
  return { constraints: [...constraintByClaim.values()], detail: [...detailByClaim.values()], providers, gaps: [...gaps], truncated, labels };
}
