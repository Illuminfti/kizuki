import { resolveWorldObject } from "../references";
import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => readKnownCard(frame, handle, "concept", when);

export const conceptOp: ClaimsOp<WorldObjectRef> = {
  source: "claims",
  name: "concept",
  keys: { required: ["concept"], optional: [] },
  dataSchemas: ["kizuki.concept-card/v1"],
  views: true,
  knownAt: true,
  readObject,
  parse: (input) => parseWorldRef(input["concept"], "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
