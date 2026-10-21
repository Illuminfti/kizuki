import { WORLD_SLICE_SCHEMA, type WorldSlice, type SliceItem } from "../../contracts/world-slice";
import type { ViewGap, ValidQuery } from "../../contracts/world-card-kit";
import { PACKET_TOKENIZER_ID, packetTokens } from "../../serving/packet-tokenizer";
import type { SliceCandidates } from "./providers";

/** Covers the closed WorldView wrapper, its largest opaque token and expiry. */
const VIEW_WRAPPER_TOKENS = 200;

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
