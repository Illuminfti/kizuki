import { FrameworkCycleError } from "../framework-cycles";
import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import { resolveWorldObject } from "../references";
import type { ClaimsOp, WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => {
  try { return readKnownCard(frame, handle, "framework", when); }
  catch (error) { if (error instanceof FrameworkCycleError) return { status: "unavailable", reason: "storage" }; throw error; }
};
export const frameworkOp: ClaimsOp<WorldObjectRef> = {
  source: "claims", name: "framework", keys: { required: ["framework"], optional: [] },
  dataSchemas: ["kizuki.framework-card/v1"], views: true, knownAt: true, readObject,
  parse: input => parseWorldRef(input.framework, "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
