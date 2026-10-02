import { sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";
import type { EligibleSupport } from "./pipeline/eligible";
import { charge, WorldProjectionBudgetError, type ReadFrame } from "./pipeline/frame";

export type Independence = "independent" | "dependent" | "unknown";
export interface SupportLineage {
  readonly status: "known" | "unknown";
  /** Internal basis identities, never wire refs or additional witnesses. */
  readonly roots: readonly string[];
  readonly count: number;
  readonly independence: ReadonlyMap<string, Independence>;
}

const COPY_FIELDS = ["forward_from", "forwarded_from", "copied_from", "copy_of", "derived_from", "generated_from"];
function derivation(metadata: unknown): Independence {
  if (!isPlainObject(metadata)) return "unknown";
  if (COPY_FIELDS.some((key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== false)) return "dependent";
  if (metadata.lineage === undefined) return "independent";
  if (!isPlainObject(metadata.lineage)) return "unknown";
  return ["copy", "forward", "summary", "paraphrase", "derived"].includes(String(metadata.lineage.kind)) ? "dependent" : "unknown";
}

/**
 * The single support-root calculation. Inputs have already passed complete
 * world eligibility under this frame's grant. It looks up only their exact
 * events, never other sources or records, including purported copy parents.
 * Source identities, version hashes, text hashes and occurrence text identify
 * shared roots. Recorded transformations add no root; unresolved lineage is
 * unknown and cannot satisfy a two-root threshold. No authority or confidence
 * is changed by this calculation.
 */
export function supportLineage(frame: ReadFrame, input: readonly EligibleSupport[]): SupportLineage {
  const supports = [...new Map(input.map((s) => [s.row.support_key, s])).values()].sort((a, b) => a.row.support_key.localeCompare(b.row.support_key));
  if (supports.length > 256) throw new WorldProjectionBudgetError();
  const events = new Map<string, { content_hash: string; text_hash: string; text: string; metadata: string; origin: string }>();
  const independence = new Map<string, Independence>();
  const roots: Set<string>[] = [];
  const fingerprints: Set<string>[] = [];
  for (const support of supports) {
    const keys = new Set<string>([`source:${support.row.source_key}`]);
    let status: Independence = "independent";
    for (const pin of support.events) {
      let event = events.get(pin.event_id);
      if (!event) {
        const row = frame.ctx.db.query<{ content_hash: string; text_hash: string; text: string; metadata: string; origin: string }, [string]>(
          "SELECT content_hash,text_hash,text,metadata,origin FROM events WHERE event_id=?",
        ).get(pin.event_id);
        frame.stats.rowsExamined += row === null ? 0 : 1;
        if (!row) { status = "unknown"; continue; }
        charge(frame.budget, row.text);
        charge(frame.budget, row.metadata);
        event = row;
        events.set(pin.event_id, row);
      }
      if (event.content_hash !== pin.event_content_hash || sha256Hex(event.text) !== event.text_hash) { status = "unknown"; continue; }
      keys.add(`version:${event.content_hash}`);
      keys.add(`text:${event.text_hash}`);
      for (const anchor of support.admission.semantic.anchors.filter((a) => a.event_id === pin.event_id)) {
        keys.add(`occurrence:${sha256Hex(event.text.slice(anchor.start_utf16, anchor.end_utf16))}`);
      }
      let metadata: unknown;
      try { metadata = JSON.parse(event.metadata); } catch { status = "unknown"; continue; }
      const derived = event.origin === "self" ? "dependent" : derivation(metadata);
      if (derived === "unknown") status = "unknown";
      else if (derived === "dependent" && status !== "unknown") status = "dependent";
    }
    independence.set(support.row.support_key, status);
    roots.push(new Set([support.row.source_key]));
    fingerprints.push(keys);
  }
  // A support bridging two roots makes them one, regardless of input order.
  const parent = supports.map((_, i) => i);
  const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]!));
  const byFingerprint = new Map<string, number>();
  for (let i = 0; i < supports.length; i++) {
    if (independence.get(supports[i]!.row.support_key) !== "independent") continue;
    for (const key of fingerprints[i]!) {
      const prior = byFingerprint.get(key);
      if (prior !== undefined) parent[root(i)] = root(prior);
      else byFingerprint.set(key, i);
    }
  }
  const components = new Map<number, { sources: Set<string>; supports: string[] }>();
  for (let i = 0; i < supports.length; i++) {
    const key = supports[i]!.row.support_key;
    if (independence.get(key) !== "independent") continue;
    const group = root(i), existing = components.get(group);
    if (existing) {
      for (const source of roots[i]!) existing.sources.add(source);
      existing.supports.push(key);
    } else components.set(group, { sources: roots[i]!, supports: [key] });
  }
  for (const component of components.values()) {
    if (component.supports.length > 1) for (const key of component.supports) independence.set(key, "dependent");
  }
  const ids = [...components.values()].map((c) => sha256Hex(JSON.stringify([...c.sources].sort()))).sort();
  return { status: [...independence.values()].includes("unknown") ? "unknown" : "known", roots: ids, count: ids.length, independence };
}
