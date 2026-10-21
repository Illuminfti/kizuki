import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import { resolveWorldObject } from "../references";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => readKnownCard(frame, handle, "skill", when);
export const skillOp: ClaimsOp<WorldObjectRef> = {
  source: "claims", name: "skill", keys: { required: ["skill"], optional: [] },
  dataSchemas: ["kizuki.skill-card/v1"], views: true, knownAt: true, readObject,
  parse: input => parseWorldRef(input.skill, "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
