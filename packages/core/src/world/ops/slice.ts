import { worldViewProjection } from "../../serving/world-clamp";
import { WORLD_SLICE_SCHEMA } from "../../contracts/world-slice";
import { utf8ByteLength } from "../../util/validate";
import { collectSlice } from "../slice/providers";
import { compileSlice } from "../slice/compile";
import { coveredOutcome } from "./outcome";
import type { ClaimsOp } from "./types";

export interface SliceQuery { readonly task: string; readonly kinds: readonly string[]; readonly budgetTokens: number }
export const sliceOp: ClaimsOp<SliceQuery> = {
  source: "claims", name: "slice", views: true,
  keys: { required: ["task", "budgetTokens"], optional: ["kinds"] }, dataSchemas: [WORLD_SLICE_SCHEMA],
  parse: ({ task, budgetTokens, kinds = ["concept", "situation"] }) => {
    if (typeof task !== "string" || utf8ByteLength(task) > 512 || !Number.isSafeInteger(budgetTokens) || Number(budgetTokens) < 50 || Number(budgetTokens) > 2000 ||
      !Array.isArray(kinds) || kinds.length === 0 || kinds.length > 16 || new Set(kinds).size !== kinds.length ||
      kinds.some(kind => typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(kind))) return null;
    return { task, budgetTokens: budgetTokens as number, kinds };
  },
  run: (frame, query, when) => {
    const data = compileSlice(collectSlice(frame, query.kinds, when, query.task), query.task, query.budgetTokens, when.valid, value => worldViewProjection(frame.ctx, value));
    return data === null ? { status: "unavailable", reason: "budget" } : coveredOutcome(data);
  },
};
