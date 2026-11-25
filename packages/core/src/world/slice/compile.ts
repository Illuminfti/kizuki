import { WORLD_SLICE_SCHEMA, type WorldSlice, type SliceItem } from "../../contracts/world-slice";
import type { ViewGap, ValidQuery } from "../../contracts/world-card-kit";
import { PACKET_TOKENIZER_ID, packetTokens } from "../../serving/packet-tokenizer";
import type { SliceCandidates } from "./providers";

/** Covers the closed WorldView wrapper, its largest opaque token and expiry. */
const VIEW_WRAPPER_TOKENS = 200;
/** Share of post-header packet room reserved for typed slice units so canon and capture still fit. */
export const PACKET_SLICE_SHARE = 0.6;

export function packetSliceBudget(headerTokens: number, budgetTokens: number): number {
  return headerTokens + Math.floor(Math.max(0, budgetTokens - headerTokens) * PACKET_SLICE_SHARE);
}

function counted(data: WorldSlice, project: (value: WorldSlice) => WorldSlice): WorldSlice {
  let result = data;
  for (let i = 0; i < 8; i++) {
    const tokens = packetTokens(JSON.stringify(project(result)));
    if (tokens === result.tokens) return result;
    result = { ...result, tokens };
  }
  throw new Error("world slice token count did not settle");
}

/** Shared mandatory-first compiler for wire slices and rendered session sections.
 * The renderer measures its entire candidate, so qualifiers remain indivisible. */
export function compileUnits<T>(constraints: readonly T[], detail: readonly T[], fits: (constraints: readonly T[], detail: readonly T[]) => boolean) {
  if (!fits(constraints, [])) return { constraints: [] as readonly T[], detail: [] as readonly T[], overflow: true, truncated: true };
  const selected: T[] = [];
  let truncated = false;
  for (const unit of detail) {
    if (!fits(constraints, [...selected, unit])) { truncated = true; continue; }
    selected.push(unit);
  }
  return { constraints, detail: selected as readonly T[], overflow: false, truncated };
}

/** Compile packet slice units within the shared slice budget so canon and capture still fit.
 * Allows the highest-priority required unit up to the full packet budget when the share alone is narrower. */
export function compilePacketUnits<T>(
  required: readonly T[],
  detail: readonly T[],
  within: (constraints: readonly T[], detail: readonly T[], limit: number) => boolean,
  shareLimit: number,
  fullLimit: number,
) {
  const fitsShare = (constraints: readonly T[], details: readonly T[]) => within(constraints, details, shareLimit);
  const compiled = compileUnits(required, detail, fitsShare);
  if (!compiled.overflow) return compiled;
  const prefix: T[] = [];
  for (const unit of required) {
    const limit = prefix.length === 0 ? fullLimit : shareLimit;
    if (!within([...prefix, unit], [], limit)) break;
    prefix.push(unit);
  }
  const overflow = prefix.length < required.length;
  if (!fitsShare(prefix, [])) {
    return { constraints: prefix as readonly T[], detail: [] as readonly T[], overflow, truncated: true };
  }
  return { ...compileUnits(prefix, detail, fitsShare), overflow, truncated: true };
}

/** Keep whole qualifications and evidence. No claim is shortened to win a budget. */
export function compileSlice(candidates: SliceCandidates, task: string, budgetTokens: number, valid: ValidQuery, project: (value: WorldSlice) => WorldSlice = value => value): WorldSlice | null {
  const make = (constraints: readonly SliceItem[], detail: readonly SliceItem[], gaps: readonly ViewGap[], truncated: boolean) => counted({
    schema: WORLD_SLICE_SCHEMA, task, budgetTokens, tokens: 0, tokenizer: PACKET_TOKENIZER_ID,
    constraints, detail, providers: candidates.providers, complete: gaps.length === 0,
    truncated, coverage: { status: gaps.length === 0 ? "complete_for_query" : "partial", gaps, validWindow: valid, history: "unavailable" },
  }, project);
  const fits = (data: WorldSlice) => data.tokens + VIEW_WRAPPER_TOKENS <= budgetTokens;
  const compiled = compileUnits(candidates.constraints, candidates.detail,
    (constraints, detail) => fits(make(constraints, detail, candidates.gaps, true)));
  const data = make(compiled.constraints, compiled.detail,
    compiled.overflow ? [...new Set<ViewGap>([...candidates.gaps, "required_context_overflow"])] : candidates.gaps,
    compiled.truncated || candidates.truncated);
  return fits(data) ? data : null;
}
