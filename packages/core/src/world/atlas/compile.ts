import { ATLAS_SCHEMA, type Atlas, type AtlasEntry, type AtlasPanel, type AtlasPanelName, type AtlasObjectOperation } from "../../contracts/atlas";
import { coverage as validCoverage, type Coverage, type ViewGap, type Relation } from "../../contracts/world-card-kit";
import { isPlainObject } from "../../util/validate";
import { projectedRelations } from "../slice/providers";
import type { ClaimsOp, ViewToken, WorldFrame, WorldObjectRef, WorldOpData, WorldRecord, WorldWhen } from "../ops/types";
import type { WorldEvidenceSource } from "../ops/evidence-types";

export interface AtlasQuery { readonly panel: AtlasPanelName; readonly focus: { readonly operation: AtlasObjectOperation; readonly ref: WorldObjectRef } | null; readonly baselineView: ViewToken | null }
type PanelName = Exclude<AtlasPanelName, "home">;
const TITLES: Record<PanelName, string> = { resume: "Resume my work", changed: "What changed", people: "People", questions: "Questions", commitments: "Commitments", stale: "Stale evidence", corrections: "Corrections and impact" };
/** Stable order; missing providers are an explicit unavailable panel. */
export const ATLAS_PROVIDER_SLOTS = ["resume", "changed", "people", "questions", "commitments", "stale", "corrections"] as const;
const cov = (when: WorldWhen, gaps: Iterable<ViewGap> = []): Coverage => {
  const all = [...new Set(gaps)].sort() as ViewGap[];
  return { status: all.length ? "partial" : "complete_for_query", gaps: all, validWindow: when.valid, history: when.knownAt.kind === "current" ? "baseline_only" : "retained_for_query" };
};
function panel(name: PanelName, coverage: Coverage, entries: readonly AtlasEntry[] = [], reason: AtlasPanel["reason"] = null): AtlasPanel {
  return { panel: name, title: TITLES[name], status: reason ? "unavailable" : coverage.status === "partial" ? "partial" : entries.length ? "ready" : "empty", reason, entries, coverage, change: null, nextView: null };
}
const nodeKey = (operation: AtlasObjectOperation) => operation === "artifact_version" ? "artifact" : operation;
function cardEntry(operation: AtlasObjectOperation, data: WorldOpData, relations = projectedRelations(data)): AtlasEntry {
  const node = data[nodeKey(operation)] as { ref: WorldObjectRef; labels: readonly { text: string }[] };
  return { ref: node.ref, operation, title: node.labels[0]?.text ?? "Untitled", relations: relations.slice(0, 12), facts: [] };
}

/** Compose public projections only. The host supplies shared byte/work bounds and independent dependency closures. */
export function compileAtlas(frame: WorldFrame, query: AtlasQuery, when: WorldWhen): { data: Atlas; quoted: readonly WorldEvidenceSource[] } {
  const quoted: WorldEvidenceSource[] = [];
  const has = (name: string) => frame.registry.some(op => op.name === name);
  const read = (input: WorldRecord, retain = false) => {
    const result = frame.read!({ ...input, valid: when.valid, knownAt: when.knownAt }, { retain });
    quoted.push(...result.quoted);
    return result.data;
  };
  const body = (input: WorldRecord): { data: WorldOpData | null; reason: AtlasPanel["reason"]; coverage: Coverage } => {
    if (!has(String(input.operation))) return { data: null, reason: "not_landed", coverage: cov(when, ["coverage"]) };
    const result = read(input);
    if ("status" in result) return { data: null, reason: null, coverage: cov(when) };
    const value = result.result;
    if (value.status === "unavailable") return { data: null, reason: value.reason, coverage: cov(when, ["coverage"]) };
    if (!("data" in value)) return { data: null, reason: "baseline_unusable", coverage: cov(when, ["coverage"]) };
    return { data: value.data, reason: null, coverage: "coverage" in value.data && validCoverage(value.data.coverage) ? value.data.coverage : cov(when) };
  };
  const browse = (name: PanelName, operation: "person" | "question" | "situation" | "concept", staleOnly = false): AtlasPanel => {
    const discovery = operation === "person" ? "find_people" : `find_${operation}s`;
    if (!has(operation)) return panel(name, cov(when, ["coverage"]), [], "not_landed");
    const matches = body({ operation: discovery, label: "" });
    if (matches.reason || !matches.data) return panel(name, matches.coverage, [], matches.reason);
    const data = matches.data as WorldOpData & { matches: readonly { ref: WorldObjectRef }[]; cursor: string | null };
    const gaps = new Set(matches.coverage.gaps), entries: AtlasEntry[] = [];
    if (data.matches.length > 4 || data.cursor !== null) gaps.add("traversal_limit");
    for (const match of data.matches.slice(0, 4)) {
      const card = body({ operation, [operation]: match.ref, ...(operation === "situation" ? { card: "kizuki.situation-card/v2" } : {}) });
      card.coverage.gaps.forEach(gap => gaps.add(gap));
      if (card.reason) return panel(name, cov(when, [...gaps, "coverage"]), [], card.reason);
      if (!card.data) continue;
      if (staleOnly && !card.coverage.gaps.some(gap => gap === "stale_dependencies" || gap === "pending_consolidation")) continue;
      let relations = projectedRelations(card.data);
      if (name === "commitments") {
        const commitments = card.data.commitments as readonly { status: string; overdue: boolean | "unknown" }[];
        relations = [...projectedRelations(commitments), ...projectedRelations(card.data.statedCommitments)];
        if (!relations.length && !commitments.length) continue;
        const entry = cardEntry(operation, card.data, relations);
        entries.push({ ...entry, facts: commitments.slice(0, 4).map(one => ({ label: "Commitment state", value: `${one.status}; overdue: ${one.overdue}` })) });
        if (commitments.length > 4) gaps.add("traversal_limit");
      } else entries.push(cardEntry(operation, card.data, relations));
      if (relations.length > 12) gaps.add("traversal_limit");
    }
    return panel(name, cov(when, gaps), entries);
  };
  const resume = (): AtlasPanel => {
    const result = body({ operation: "slice", task: "Resume my work", kinds: ["concept", "situation", "person", "question", "procedure"], budgetTokens: 2000 });
    if (result.reason || !result.data) return panel("resume", result.coverage, [], result.reason);
    const items = [...result.data.constraints as readonly {kind:string; node:WorldObjectRef; relation:Relation}[], ...result.data.detail as readonly {kind:string; node:WorldObjectRef; relation:Relation}[]];
    const entries: AtlasEntry[] = [], gaps = new Set(result.coverage.gaps);
    for (const item of items) {
      const existing = entries.find(entry => entry.ref?.token === item.node.token);
      if (existing) {
        if (existing.relations.length < 12) (existing.relations as Relation[]).push(item.relation); else gaps.add("traversal_limit");
      } else if (entries.length < 4) entries.push({ ref: item.node, operation: item.kind as AtlasObjectOperation, title: `Recorded ${item.kind}`, relations: [item.relation], facts: [] });
      else gaps.add("traversal_limit");
    }
    return panel("resume", cov(when, gaps), entries);
  };
  const changes = (name: "changed" | "corrections"): AtlasPanel => {
    if (!has("diff")) return panel(name, cov(when, ["coverage"]), [], "not_landed");
    const { focus, baselineView } = query;
    if (!focus || !baselineView) return panel(name, cov(when, ["coverage"]), [], "baseline_required");
    const target = frame.registry.find(op => op.name === focus.operation) as ClaimsOp | undefined;
    if (!target?.readObject) return panel(name, cov(when, ["coverage"]), [], "not_landed");
    const of = { operation: focus.operation, [focus.operation]: focus.ref };
    const result = read({ operation: "diff", of, priorView: baselineView }, true);
    if ("status" in result || result.result.status === "new_view_required") return panel(name, cov(when, ["coverage"]), [], "baseline_unusable");
    const value = result.result;
    if (value.status === "unavailable") return panel(name, cov(when, ["coverage"]), [], value.reason);
    if (value.status === "incomplete") return panel(name, cov(when, value.reasons), []);
    const change = value.status === "unchanged" ? { added: [], removed: [], changed: [], truncated: false } :
      "data" in value && value.data.schema === "kizuki.world-diff/v1" ? value.data as unknown as NonNullable<AtlasPanel["change"]> : null;
    if (!change) return panel(name, cov(when, ["coverage"]), [], "baseline_unusable");
    const gaps = new Set<ViewGap>(change.truncated ? ["traversal_limit"] : []);
    const entries: AtlasEntry[] = [];
    if (name === "corrections") {
      const current = body(of);
      current.coverage.gaps.forEach(gap => gaps.add(gap));
      if (current.reason) return panel(name, cov(when, [...gaps, "coverage"]), [], current.reason);
      if (current.data) {
        const corrections = projectedRelations(current.data).filter(item => item.assessments.some(one => one.authority === "owner_correction"));
        if (corrections.length) entries.push(cardEntry(focus.operation, current.data, corrections));
        if (corrections.length > 12) gaps.add("traversal_limit");
      }
    }
    // Changes are observable differences, not a claim that a correction caused every difference.
    const count = change.added.length + change.removed.length + change.changed.length;
    return { ...panel(name, cov(when, gaps), entries), status: gaps.size ? "partial" : count || entries.length ? "ready" : "empty",
      change: { added: change.added, removed: change.removed, changed: change.changed, truncated: change.truncated },
      nextView: "view" in value && value.view.kind === "view" ? value.view : null };
  };
  const one = (name: PanelName): AtlasPanel => {
    if (!frame.read) return panel(name, cov(when, ["coverage"]), [], "not_landed");
    if (name === "changed" || name === "corrections") return changes(name);
    if (name === "resume") return resume();
    if (name === "people") return browse(name, "person");
    if (name === "questions") return browse(name, "question");
    if (name === "commitments") return browse(name, "situation");
    // Consolidation coverage is reported by the same cards; never inspect denied aggregate counts.
    const concepts = browse(name, "concept", true), situations = browse(name, "situation", true);
    const gaps = new Set([...concepts.coverage.gaps, ...situations.coverage.gaps]);
    if (concepts.entries.length + situations.entries.length > 4) gaps.add("traversal_limit");
    return panel(name, cov(when, gaps), [...concepts.entries, ...situations.entries].slice(0, 4), concepts.reason ?? situations.reason);
  };
  const panels = (query.panel === "home" ? ATLAS_PROVIDER_SLOTS : [query.panel]).map(one);
  const coverage = cov(when, panels.flatMap(one => one.coverage.gaps));
  return { data: { schema: ATLAS_SCHEMA, panel: query.panel, panels, coverage }, quoted };
}
