import { resolveWorldObject } from "../references";
import { readKnownCard } from "../known/reader";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { parseWorldRef, isWorldWireToken } from "./parse";
import { readWorldMatches } from "../pipeline/read";
import { newReadFrame } from "../pipeline/frame";
import { WORLD_DISCOVERY_SCAN_BUDGET } from "../pipeline/collect";
import { WorldViewError, type ClaimsOp, type WorldObjectRef } from "./types";

const readObject: NonNullable<ClaimsOp["readObject"]> = (frame, handle, when) => readKnownCard(frame, handle, "artifact_version", when);
export const artifactVersionOp: ClaimsOp<WorldObjectRef> = {
  source: "claims", name: "artifact_version", keys: { required: ["artifact"], optional: [] },
  dataSchemas: ["kizuki.artifact-card/v1"], views: true, knownAt: true, readObject,
  parse: input => parseWorldRef(input.artifact, "object"),
  run: (frame, ref, when) => {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? { status: "new_view_required" } : NOT_FOUND) : readObject(frame, handle, when);
  },
};
export const findArtifactsOp: ClaimsOp<{ label: string; cursor: string | null }> = {
  source: "claims", name: "find_artifacts", keys: { required: [], optional: ["label", "cursor"] },
  dataSchemas: ["kizuki.artifact_version-matches/v1"], views: true,
  parse: input => {
    const label = input.label ?? "", cursor = input.cursor ?? null;
    return typeof label === "string" && label.length <= 200 && (cursor === null || typeof cursor === "string" && isWorldWireToken(cursor)) ? { label, cursor } : null;
  },
  run: ({ ctx, ns, dependencies }, { label, cursor }, { valid }) => {
    const after = cursor === null ? null : resolveWorldObject(ctx.db, ns, cursor);
    if (cursor !== null && after === null) throw new WorldViewError();
    return coveredOutcome(readWorldMatches(newReadFrame(ctx, ns, valid, dependencies), "artifact_version", label, after, WORLD_DISCOVERY_SCAN_BUDGET));
  },
};
