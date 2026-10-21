import { canonicalJson, sha256Hex } from "../../util/hash";
import type { Eligible, EligibleSupport } from "../pipeline/eligible";
import type { Cluster } from "../pipeline/group";
import { charge, type ReadFrame } from "../pipeline/frame";
import { COLLECTORS, collectCard, verifyClaim } from "../pipeline/collect";
import { GROUPERS, group } from "../pipeline/group";
import { worldDependencies, recordWorldDependencies } from "../dependencies";
import { knownSupportSql } from "../known/cutoff";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";

export interface ConsolidationPin {
  readonly key: string;
  readonly claim: string;
  readonly source: string;
  readonly admission: string;
  readonly events: readonly { event_id: string; event_content_hash: string }[];
}
export interface ConsolidationBasis {
  readonly digest: string;
  readonly anchor: string;
  readonly kind: string;
  readonly members: readonly string[];
  readonly items: readonly Eligible[];
  readonly supports: readonly EligibleSupport[];
  readonly pins: readonly ConsolidationPin[];
  readonly eventIds: readonly string[];
}
/** Nothing outside the reader's complete eligible cluster contributes to identity. */
export function consolidationBasis(frame: ReadFrame, cluster: Cluster, kind: string, items: readonly Eligible[], overflow: boolean): ConsolidationBasis | null {
  if (overflow || cluster.overflow || items.length === 0 || items.some((item) => item.overflow)) return null;
  // Group proof has its own dependency set, so another card in the caller's
  // aggregate closure cannot alter this basis. Work still consumes the same
  // bounded read budget and counters. Native receipt ownership is part of the
  // digest even when another valid edge would leave the member set unchanged.
  const deps = worldDependencies(), proofFrame: ReadFrame = { ...frame, dependencies: deps };
  const proof = group(proofFrame, cluster.anchor, GROUPERS);
  if (proof.overflow || proof.resolution !== cluster.resolution || canonicalJson([...proof.members].sort()) !== canonicalJson([...cluster.members].sort())) return null;
  const identityItems = [...deps.claims].sort().map(id => verifyClaim(proofFrame, id));
  if (identityItems.some(item => item === null || item.overflow)) return null;
  const evidence = [...new Map([...items, ...identityItems as Eligible[]].map(item => [item.claimId, item])).values()];
  for (const item of items) recordWorldDependencies(deps, item);
  if (frame.dependencies !== undefined) {
    for (const item of evidence) recordWorldDependencies(frame.dependencies, item);
    for (const key of deps.supports) frame.dependencies.supports.add(key);
    for (const event of deps.events) frame.dependencies.events.add(event);
    for (const [claim, receipt] of deps.identityReceipts) frame.dependencies.identityReceipts.set(claim, receipt);
  }
  const supports = [...new Map(evidence.flatMap((item) => item.supports).map((support) => [support.row.support_key, support])).values()]
    .sort((a, b) => a.row.support_key.localeCompare(b.row.support_key));
  if (deps.supports.size > 256) return null;
  // Retained grounding labels can remain valid proof after their claim is
  // superseded. Pin their authorized support bytes and events without imposing
  // current claim liveness or counting them as independent summary testimony.
  const permitted = knownSupportSql(frame.ctx, frame.cutoff.kind === "current" ? undefined : frame.cutoff);
  const rows = frame.ctx.db.query<{ support_key: string; claim_id: string; source_key: string; admission: string }, (string | number)[]>(
    `SELECT s.support_key,s.claim_id,s.source_key,s.admission FROM claim_v2_support s WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${permitted.sql} ORDER BY s.support_key`,
  ).all(JSON.stringify([...deps.supports]), ...permitted.bindings);
  frame.stats.rowsExamined += rows.length;
  for (const row of rows) charge(frame.budget, row.admission);
  if (rows.length !== deps.supports.size) return null;
  const pins: ConsolidationPin[] = rows.map(row => ({ key: row.support_key, claim: row.claim_id, source: row.source_key, admission: sha256Hex(row.admission),
    events: frame.ctx.db.query<{ event_id: string; event_content_hash: string }, [string]>("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id").all(row.support_key) }));
  const members = [...new Set(cluster.members)].sort();
  const identity = { schema: "kizuki.consolidation-basis/v1", anchor: cluster.anchor, kind, members, resolution: cluster.resolution,
    pins,
    identityReceipts: [...deps.identityReceipts].sort(([a], [b]) => a.localeCompare(b)),
    claims: evidence.map((item) => ({ claim: item.claimId, semantic: item.semantic,
      supports: item.supports.map((support) => ({ key: support.row.support_key, admission: sha256Hex(support.row.admission), events: support.events }))
        .sort((a, b) => a.key.localeCompare(b.key)) })).sort((a, b) => a.claim.localeCompare(b.claim)) };
  return { digest: sha256Hex(canonicalJson(identity)), anchor: cluster.anchor, kind, members, items, supports, pins,
    eventIds: [...new Set(pins.flatMap((support) => support.events.map((event) => event.event_id)))].sort() };
}
export function collectConsolidationBasis(frame: ReadFrame, handle: string, kindId: string): ConsolidationBasis | null {
  const kind = activeWorldRegistry().kind(kindId);
  if (kind === undefined) return null;
  const cluster = group(frame, handle, GROUPERS);
  const collection = collectCard(frame, cluster, kind, COLLECTORS);
  return collection === null ? null : consolidationBasis(frame, cluster, kindId, collection.items, collection.overflow);
}
