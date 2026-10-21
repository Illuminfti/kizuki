import { resolveWorldObject } from "../references";
import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => readKnownCard(frame, handle, "situation", when);

export const situationOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "situation",
  keys: { required: ["situation"], optional: [] },
  dataSchemas: ["kizuki.situation-card/v1"],
  views: true,
  knownAt: true,
  readObject,
  parse: (input) => parseWorldRef(input["situation"], "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
