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

/** Keep whole qualifications and evidence. No claim is shortened to win a budget. */
export function compileSlice(candidates: SliceCandidates, task: string, budgetTokens: number, valid: ValidQuery, project: (value: WorldSlice) => WorldSlice = value => value): WorldSlice | null {
  const make = (constraints: readonly SliceItem[], detail: readonly SliceItem[], gaps: readonly ViewGap[], truncated: boolean) => counted({
    schema: WORLD_SLICE_SCHEMA, task, budgetTokens, tokens: 0, tokenizer: PACKET_TOKENIZER_ID,
    constraints, detail, providers: candidates.providers, complete: gaps.length === 0,
    truncated, coverage: { status: gaps.length === 0 ? "complete_for_query" : "partial", gaps, validWindow: valid, history: "unavailable" },
  }, project);
  const fits = (data: WorldSlice) => data.tokens + VIEW_WRAPPER_TOKENS <= budgetTokens;
  let data = make(candidates.constraints, [], candidates.gaps, candidates.truncated);
  if (!fits(data)) {
    data = make([], [], [...new Set<ViewGap>([...candidates.gaps, "required_context_overflow"])], true);
    return fits(data) ? data : null;
  }
  const detail: SliceItem[] = [];
  for (const item of candidates.detail) {
    const next = make(candidates.constraints, [...detail, item], candidates.gaps, candidates.truncated);
    if (!fits(next)) { data = make(candidates.constraints, detail, candidates.gaps, true); break; }
    detail.push(item); data = next;
  }
  return data;
}
