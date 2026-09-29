import { resolveWorldObject } from "../references";
import { projectWorldCard } from "../projection";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

export const conceptOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "concept",
  keys: { required: ["concept"], optional: [] },
  dataSchemas: ["kizuki.concept-card/v1"],
  parse: (input) => parseWorldRef(input["concept"], "object"),
  run: ({ ctx, ns }, ref, { valid }) => {
    const handle = resolveWorldObject(ctx.db, ns, ref.token);
    if (handle === null) return NOT_FOUND;
    const card = projectWorldCard(ctx, ns, handle, "concept", valid);
    return card === null ? NOT_FOUND : coveredOutcome(card);
  },
};
