import { WORLD_DISCOVERY_SCAN_BUDGET } from "../pipeline/collect";
import { newReadFrame } from "../pipeline/frame";
import { readWorldMatches } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import { coveredOutcome } from "./outcome";
import { isWorldWireToken } from "./parse";
import { WorldViewError, type ClaimsOp } from "./types";
export const findPeopleOp: ClaimsOp<{ label: string; cursor: string | null }> = {
  source: "claims", name: "find_people", keys: { required: [], optional: ["label", "cursor"] },
  dataSchemas: ["kizuki.person-matches/v1"], views: true,
  parse: input => {
    const label = Object.hasOwn(input, "label") ? input.label : "";
    const cursor = Object.hasOwn(input, "cursor") ? input.cursor : null;
    if (typeof label !== "string" || label.length > 200) return null;
    if (!Object.hasOwn(input, "cursor")) return { label, cursor: null };
    return typeof cursor === "string" && isWorldWireToken(cursor) ? { label, cursor } : null;
  },
  run: ({ ctx, ns, dependencies }, { label, cursor }, { valid }) => {
    const after = cursor === null ? null : resolveWorldObject(ctx.db, ns, cursor);
    if (cursor !== null && after === null) throw new WorldViewError();
    return coveredOutcome(readWorldMatches(newReadFrame(ctx, ns, valid, dependencies), "person", label, after, WORLD_DISCOVERY_SCAN_BUDGET));
  },
};
