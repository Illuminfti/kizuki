import { readKnownHistory } from "../known/reader";
import { resolveWorldObject } from "../references";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";
export const historyOp: ClaimsOp<WorldObjectRef> = {
  source: "claims", name: "history", keys: { required: ["concept"], optional: [] },
  dataSchemas: ["kizuki.world-history/v1"], views: true, knownAt: true,
  parse: input => parseWorldRef(input.concept, "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readKnownHistory(frame, handle, when);
  },
};
