import { resolveWorldObject } from "../references";
import { projectWorldCard } from "../projection";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

export const situationOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "situation",
  keys: { required: ["situation"], optional: [] },
  dataSchemas: ["kizuki.situation-card/v1"],
  parse: (input) => parseWorldRef(input["situation"], "object"),
  run: ({ ctx, ns }, ref, { valid }) => {
    const handle = resolveWorldObject(ctx.db, ns, ref.token);
    if (handle === null) return NOT_FOUND;
    const card = projectWorldCard(ctx, ns, handle, "situation", valid);
    return card === null ? NOT_FOUND : coveredOutcome(card);
  },
};
