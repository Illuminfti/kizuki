import { canonicalJson, sha256Hex } from "../../util/hash";
import type { Eligible, EligibleSupport } from "../pipeline/eligible";
import type { Cluster } from "../pipeline/group";
import type { ReadFrame } from "../pipeline/frame";
import { COLLECTORS, collectCard } from "../pipeline/collect";
import { GROUPERS, group } from "../pipeline/group";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";

export interface ConsolidationBasis {
  readonly digest: string;
  readonly anchor: string;
  readonly kind: string;
  readonly members: readonly string[];
  readonly items: readonly Eligible[];
  readonly supports: readonly EligibleSupport[];
  readonly eventIds: readonly string[];
}
/** Nothing outside the reader's complete eligible cluster contributes to identity. */
export function consolidationBasis(cluster: Cluster, kind: string, items: readonly Eligible[], overflow: boolean): ConsolidationBasis | null {
  if (overflow || items.length === 0 || items.some((item) => item.overflow)) return null;
  const supports = [...new Map(items.flatMap((item) => item.supports).map((support) => [support.row.support_key, support])).values()]
    .sort((a, b) => a.row.support_key.localeCompare(b.row.support_key));
  if (supports.length > 256) return null;
  const members = [...new Set(cluster.members)].sort();
  const identity = { schema: "kizuki.consolidation-basis/v1", anchor: cluster.anchor, kind, members,
    claims: items.map((item) => ({ claim: item.claimId, semantic: item.semantic,
      supports: item.supports.map((support) => ({ key: support.row.support_key, admission: sha256Hex(support.row.admission), events: support.events }))
        .sort((a, b) => a.key.localeCompare(b.key)) })).sort((a, b) => a.claim.localeCompare(b.claim)) };
  return { digest: sha256Hex(canonicalJson(identity)), anchor: cluster.anchor, kind, members, items, supports,
    eventIds: [...new Set(supports.flatMap((support) => support.events.map((event) => event.event_id)))].sort() };
}
export function collectConsolidationBasis(frame: ReadFrame, handle: string, kindId: string): ConsolidationBasis | null {
  const kind = activeWorldRegistry().kind(kindId);
  if (kind === undefined) return null;
  const cluster = group(frame, handle, GROUPERS);
  const collection = collectCard(frame, cluster, kind, COLLECTORS);
  return collection === null ? null : consolidationBasis(cluster, kindId, collection.items, collection.overflow);
}
