import { resolveWorldObject } from "../references";
import { projectWorldCard } from "../projection";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = ({ ctx, ns, dependencies }, handle, { valid }) => {
  const card = projectWorldCard(ctx, ns, handle, "concept", valid, dependencies);
  return card === null ? NOT_FOUND : coveredOutcome(card);
};

export const conceptOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "concept",
  keys: { required: ["concept"], optional: [] },
  dataSchemas: ["kizuki.concept-card/v1"],
  views: true,
  readObject,
  parse: (input) => parseWorldRef(input["concept"], "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? NOT_FOUND : readObject(frame, handle, when);
  },
};
