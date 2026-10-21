import { identityGrouper } from "../identity";
import type { ReadFrame } from "./frame";

/**
 * The endpoints a scoped read treats as one thing. Identity widens `members`
 * only from eligible evidence and reports its resolution. The requested handle
 * is always the `anchor` and no member is a global representative.
 */
export interface Cluster {
  readonly anchor: string;
  readonly members: readonly string[];
  readonly overflow?: boolean;
  readonly resolution: "distinct" | "resolved" | "ambiguous";
}

/**
 * Refines the cluster the groupers before it left, retaining the anchor.
 * Discovery requires a consistent component: for each member, grouping must
 * return the same member set under this frame. Directional hints belong in a
 * collector, not an identity component.
 */
export type Grouper = (frame: ReadFrame, cluster: Cluster) => Cluster;

/** Ordered. A workstream adds one line under its marker. */
export const GROUPERS: readonly Grouper[] = [
  // slot: ident
  identityGrouper,
];

export function group(
  frame: ReadFrame,
  handle: string,
  groupers: readonly Grouper[],
): Cluster {
  const start: Cluster = {
    anchor: handle,
    members: [handle],
    resolution: "distinct",
  };
  return groupers.reduce((cluster, grouper) => {
    const next = grouper(frame, cluster);
    if (next.anchor !== handle || !next.members.includes(handle))
      throw new Error("a world grouper must keep the requested handle");
    return next;
  }, start);
}
