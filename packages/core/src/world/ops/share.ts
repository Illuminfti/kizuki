import { isPlainObject } from "../../util/validate";
import { resolveWorldObject } from "../references";
import { issueResume, RESUME_SCHEMA } from "../views/resume";
import { findWorldOp } from "./registry";
import { hasWorldKeys, parseWorldRef } from "./parse";
import { NOT_FOUND } from "./outcome";
import { WorldViewError, type ClaimsOp, type WorldRecord } from "./types";

export const shareOp: ClaimsOp<WorldRecord> = {
  source: "claims", name: "share",
  keys: { required: ["of"], optional: [] },
  dataSchemas: [RESUME_SCHEMA],
  parse: ({ of }) => isPlainObject(of) ? of : null,
  run: (frame, of, when) => {
    const op = findWorldOp(frame.registry, of.operation);
    // One semantic object read; no nested share, baseline or second time axis.
    if (op?.source !== "claims" || op.readObject === undefined || op.keys.required.length !== 1 ||
      !hasWorldKeys(of, ["operation", ...op.keys.required], []) || op.parse(of) === null) throw new WorldViewError();
    const ref = parseWorldRef(of[op.keys.required[0]!], "object");
    if (ref === null) throw new WorldViewError();
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    if (handle === null) return NOT_FOUND;
    const read = op.readObject(frame, handle, when);
    if (read.status !== "data") return read;
    const data = issueResume(frame.ctx.db, frame.ns, frame.ctx.principal.grant, op.name, handle, when.valid);
    return data === null ? { status: "unavailable", reason: "storage" } : { status: "data", data: { ...data }, gaps: null };
  },
};
