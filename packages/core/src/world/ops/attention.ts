import { readAttention } from "../attention/read";
import { coveredOutcome } from "./outcome";
import type { ClaimsOp } from "./types";

export const attentionOp: ClaimsOp<true> = {
  source: "claims", name: "attention", keys: { required: [], optional: [] },
  dataSchemas: ["kizuki.attention/v1"],
  parse: () => true,
  run: (frame, _query, when) => when.valid.kind === "all" ? coveredOutcome(readAttention(frame, when.valid).data) : { status: "unavailable", reason: "history" },
};
