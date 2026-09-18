import type { Change, Impact, ImpactReason, Judgment, MemoryNode, PlanStep, ReflexReport, Snapshot, SnapshotBinding, Trace } from "./types";
import { id, integer, object, timestamp, validatedInput, ReflexError } from "./validate";

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class DependencyGraph {
  readonly nodes: ReadonlyMap<string, MemoryNode>;
  private readonly next = new Map<string, string[]>();
  private readonly edgeEvidence = new Map<string, readonly string[]>();
  constructor(readonly snapshot: Snapshot) {
    this.nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    for (const edge of snapshot.dependencies) {
      const adjacent = this.next.get(edge.prerequisite) ?? [];
      adjacent.push(edge.dependent);
      this.next.set(edge.prerequisite, adjacent);
      this.edgeEvidence.set(JSON.stringify([edge.prerequisite, edge.dependent]), edge.evidence_ids);
    }
    for (const adjacent of this.next.values()) adjacent.sort();
  }
  /** One bounded breadth-first traversal per nominated root; cycles are legal. */
  reach(root: string): ReadonlyMap<string, { via: string | null; distance: number }> {
    if (!this.nodes.has(root)) throw new ReflexError("invalid_input");
    const found = new Map<string, { via: string | null; distance: number }>([[root, { via: null, distance: 0 }]]);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      for (const next of this.next.get(current) ?? []) {
        if (found.has(next)) continue;
        found.set(next, { via: current, distance: found.get(current)!.distance + 1 });
        queue.push(next);
      }
    }
    return found;
  }
  impacts(judgments: readonly Judgment[]): Impact[] {
    const impacted = new Map<string, { node: MemoryNode; effect: "needs_revalidation" | "unknown"; reasons: ImpactReason[] }>();
    for (const judgment of judgments) {
      if (judgment.effect === "no_change_detected") continue;
      for (const [nodeId, route] of this.reach(judgment.target_id)) {
        const item = impacted.get(nodeId) ?? { node: this.nodes.get(nodeId)!, effect: judgment.effect, reasons: [] };
        // A known change takes precedence over a second uncertain path, never the reverse.
        if (judgment.effect === "needs_revalidation") item.effect = judgment.effect;
        item.reasons.push({ target_id: judgment.target_id, effect: judgment.effect, ...route });
        impacted.set(nodeId, item);
      }
    }
    return [...impacted.values()].map(({ node, effect, reasons }) => ({ node_id: node.id, kind: node.kind,
      revision: node.revision, effect, consequence: node.consequence,
      reasons: reasons.sort((a, b) => compareId(a.target_id, b.target_id)) }))
      .sort((a, b) => b.consequence - a.consequence || compareId(a.node_id, b.node_id));
  }
  trace(root: string, target: string, change: Change, maxNodes = 64): Trace {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 2_000) throw new ReflexError("invalid_input");
    const routes = this.reach(root);
    if (!routes.has(target)) return { nodes: [], evidence_ids: [], truncated: false };
    const reverse: string[] = [];
    let cursor: string | null = target;
    while (cursor !== null) {
      reverse.push(cursor);
      cursor = routes.get(cursor)!.via;
    }
    const path = reverse.reverse();
    // Include complete provenance even when the display path has to be shortened.
    const evidence = new Set(change.evidence_ids);
    for (let index = 0; index < path.length; index += 1) {
      for (const source of this.nodes.get(path[index]!)!.evidence_ids) evidence.add(source);
      if (index > 0) for (const source of this.edgeEvidence.get(JSON.stringify([path[index - 1], path[index]])) ?? []) evidence.add(source);
    }
    return { nodes: path.slice(0, maxNodes), evidence_ids: [...evidence].sort(), truncated: path.length > maxNodes };
  }
}

/** A recommendation to an external agent, never permission to execute its tools. */
export function preflight(report: ReflexReport, currentBinding: SnapshotBinding, steps: readonly PlanStep[]) {
  if (!object(currentBinding) || !id(currentBinding.snapshot_id) || !id(currentBinding.principal_id) || !integer(currentBinding.policy_epoch, 0, Number.MAX_SAFE_INTEGER) || !timestamp(currentBinding.expires_at) || !Array.isArray(steps) || steps.length > 256) throw new ReflexError("invalid_input");
  const revisions = new Map(report.analyzed_revisions.map((n) => [n.node_id, n.revision]));
  const impacts = new Map(report.impacts.map((n) => [n.node_id, n]));
  const stepIds = new Set<string>();
  const advice = steps.map((step) => {
    if (!object(step) || !id(step.id) || stepIds.has(step.id) || !Array.isArray(step.assumptions) || step.assumptions.length > 128) throw new ReflexError("invalid_input");
    stepIds.add(step.id);
    const assumptions = new Set<string>();
    let unknown = report.status !== "complete" || currentBinding.snapshot_id !== report.binding.snapshot_id || currentBinding.principal_id !== report.binding.principal_id || currentBinding.policy_epoch !== report.binding.policy_epoch || currentBinding.expires_at !== report.binding.expires_at || Date.parse(currentBinding.expires_at) <= Date.now() || step.assumptions.length === 0;
    const affected: string[] = [];
    for (const item of step.assumptions) {
      if (!object(item) || !id(item.node_id) || !id(item.revision) || assumptions.has(item.node_id)) throw new ReflexError("invalid_input");
      assumptions.add(item.node_id);
      if (revisions.get(item.node_id) !== item.revision) unknown = true;
      const impact = impacts.get(item.node_id);
      if (impact?.effect === "needs_revalidation") affected.push(item.node_id);
      else if (impact?.effect === "unknown") unknown = true;
    }
    return { step_id: step.id, status: affected.length > 0 ? "revalidate" as const : unknown ? "unexamined" as const : "no_change_detected" as const,
      affected_ids: affected.sort() };
  });
  return { advisory_only: true as const, authorizes_execution: false as const, mode: report.mode, steps: advice };
}

/** Safe public trace helper: validates and copies the supplied snapshot first. */
export function traceImpact(snapshot: Snapshot, change: Change, root: string, target: string, maxNodes = 64): Trace {
  const input = validatedInput(snapshot, change);
  if (!input.change.target_ids.includes(root) || !input.snapshot.nodes.some((node) => node.id === target)) throw new ReflexError("invalid_input");
  return new DependencyGraph(input.snapshot).trace(root, target, input.change, maxNodes);
}
