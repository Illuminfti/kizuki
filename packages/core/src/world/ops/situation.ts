import { resolveWorldObject } from "../references";
import { projectWorldCard } from "../projection";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = ({ ctx, ns, dependencies }, handle, { valid }) => {
  const card = projectWorldCard(ctx, ns, handle, "situation", valid, dependencies);
  return card === null ? NOT_FOUND : coveredOutcome(card);
};

export const situationOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "situation",
  keys: { required: ["situation"], optional: [] },
  dataSchemas: ["kizuki.situation-card/v1"],
  views: true,
  readObject,
  parse: (input) => parseWorldRef(input["situation"], "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? NOT_FOUND : readObject(frame, handle, when);
  },
};
