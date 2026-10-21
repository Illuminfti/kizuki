import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import { resolveWorldObject } from "../references";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => readKnownCard(frame, handle, "question", when);
export const questionOp: ClaimsOp<WorldObjectRef> = {
  source: "claims", name: "question", keys: { required: ["question"], optional: [] },
  dataSchemas: ["kizuki.question-card/v1"], views: true, knownAt: true, readObject,
  parse: input => parseWorldRef(input.question, "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
