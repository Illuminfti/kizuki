import type { ConceptCoverage } from "../../contracts/concept-card";
import { lookupResume, scopeClipped } from "../views/resume";
import { findWorldOp, type WorldOpFactory } from "./registry";
import { isWorldWireToken } from "./parse";
import type { ClaimsOp } from "./types";

export const resumeOp: WorldOpFactory = (ops) => ({
  source: "claims", name: "resume", views: true,
  keys: { required: ["handle"], optional: [] },
  dataSchemas: ops.flatMap((op) => op.source === "claims" && op.readObject !== undefined ? op.dataSchemas : []) as [string, ...string[]],
  parse: ({ handle }) => typeof handle === "string" && isWorldWireToken(handle) ? handle : null,
  run: (frame, handle, when) => {
    const saved = lookupResume(frame.ctx, handle);
    if (saved === null) return { status: "new_view_required" };
    const op = findWorldOp(frame.registry, saved.operation);
    if (op?.source !== "claims" || op.readObject === undefined) return { status: "new_view_required" };
    // Until retained history is available, read the current revision in the shared valid window.
    const read = op.readObject(frame, saved.handle_id, { ...when, valid: saved.valid });
    if (read.status === "not_found") return { status: "new_view_required" };
    if (read.status !== "data" || !scopeClipped(frame.ctx.principal.grant, saved.scope)) return read;
    const gaps = [...new Set([...(read.gaps ?? []), "coverage" as const])];
    const coverage = read.data.coverage as ConceptCoverage;
    return { ...read, gaps, data: { ...read.data, coverage: { ...coverage, status: "partial", gaps } } };
  },
} satisfies ClaimsOp<string>);
