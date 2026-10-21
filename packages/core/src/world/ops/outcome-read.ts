import { readOutcomes } from "../outcomes";
import { newReadFrame } from "../pipeline/frame";
import { coveredOutcome, NOT_FOUND } from "./outcome";
import type { ClaimsOp } from "./types";
export const outcomeOp: ClaimsOp<string> = {
  source: "claims", name: "outcome", keys: { required: ["subject"], optional: [] }, dataSchemas: ["kizuki.outcome-card/v1"],
  parse: input => typeof input.subject === "string" && input.subject.length > 0 && input.subject.length <= 256 && !/[\x00-\x1f\x7f]/.test(input.subject) ? input.subject : null,
  run: ({ ctx, ns, dependencies }, subject, { valid }) => {
    // Legacy outcomes have no retained rich valid-time history; refuse that request honestly.
    if (valid.kind !== "all") return { status: "unavailable", reason: "history" };
    const card = readOutcomes(newReadFrame(ctx, ns, valid, dependencies), subject);
    return card.stages.length === 0 ? NOT_FOUND : coveredOutcome(card);
  },
};
