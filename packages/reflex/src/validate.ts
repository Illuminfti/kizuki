import type { Change, Failure, Limits, Snapshot, Thresholds } from "./types";

export class ReflexError extends Error {
  override readonly name = "ReflexError";
  constructor(readonly code: Failure) {
    // Deliberately never interpolate captured text, IDs, paths, or provider errors.
    super(`reflex: ${code}`);
  }
}
export const DEFAULT_LIMITS: Limits = Object.freeze({
  concurrency: 4,
  max_requests: 32,
  request_timeout_ms: 2_000,
  total_timeout_ms: 10_000,
  max_request_bytes: 24_000,
  max_total_request_bytes: 256_000,
});
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  evidence_min: 0.85,
  applicability_min: 0.85,
  relation_probability_min: 0.85,
  relation_confidence_min: 0.5,
  counterevidence_max: 0.15,
});
export function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
export function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
const unsafeIds = new Set(["__proto__", "prototype", "constructor"]);
export function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$/.test(value) && !unsafeIds.has(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
export function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);
}
function ids(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every(id) && new Set(value).size === value.length;
}
/** Snapshot copies prevent retained caller references from changing an in-flight run. */
export function validatedInput(raw: unknown, changeRaw: unknown): { snapshot: Snapshot; change: Change } {
  const invalid = (): never => { throw new ReflexError("invalid_input"); };
  if (!object(raw) || !object(raw.binding) || !Array.isArray(raw.nodes) || !Array.isArray(raw.dependencies)) invalid();
  const s = raw as Record<string, unknown>;
  const b = s.binding as Record<string, unknown>;
  const nodes = s.nodes as unknown[];
  const dependencies = s.dependencies as unknown[];
  if (!id(b.snapshot_id) || !id(b.principal_id) || !integer(b.policy_epoch, 0, Number.MAX_SAFE_INTEGER) || !timestamp(b.expires_at)) invalid();
  if (nodes.length > 2_000 || dependencies.length > 8_000) throw new ReflexError("resource_limit");
  const seen = new Set<string>();
  let chars = 0;
  for (const n of nodes) {
    if (!object(n) || !id(n.id) || !id(n.revision) || (typeof n.kind !== "string" || !["fact", "decision", "action"].includes(n.kind))
      || !text(n.statement, 8_192) || !ids(n.evidence_ids, 1, 64) || !integer(n.consequence, 0, 4)) invalid();
    const node = n as unknown as Snapshot["nodes"][number];
    if (seen.has(node.id)) invalid();
    seen.add(node.id);
    chars += node.statement.length;
  }
  if (chars > 1_000_000) throw new ReflexError("resource_limit");
  const edges = new Set<string>();
  for (const e of dependencies) {
    if (!object(e) || !id(e.prerequisite) || !id(e.dependent) || !ids(e.evidence_ids, 1, 64)) invalid();
    const edge = e as unknown as Snapshot["dependencies"][number];
    if (!seen.has(edge.prerequisite) || !seen.has(edge.dependent) || edge.prerequisite === edge.dependent) invalid();
    const key = JSON.stringify([edge.prerequisite, edge.dependent]);
    if (edges.has(key)) invalid();
    edges.add(key);
  }
  if (!object(changeRaw) || !id(changeRaw.id) || !text(changeRaw.statement, 8_192)
    || !timestamp(changeRaw.occurred_at) || !ids(changeRaw.evidence_ids, 1, 64) || !ids(changeRaw.target_ids, 1, 64)) invalid();
  const c = changeRaw as unknown as Change;
  if (!c.target_ids.every((target) => seen.has(target))) invalid();
  const original = raw as unknown as Snapshot;
  const snapshot: Snapshot = {
    binding: { snapshot_id: original.binding.snapshot_id, principal_id: original.binding.principal_id,
      policy_epoch: original.binding.policy_epoch, expires_at: original.binding.expires_at },
    nodes: original.nodes.map((n) => ({ id: n.id, kind: n.kind, revision: n.revision, statement: n.statement,
      evidence_ids: [...n.evidence_ids], consequence: n.consequence })),
    dependencies: original.dependencies.map((e) => ({ prerequisite: e.prerequisite, dependent: e.dependent,
      evidence_ids: [...e.evidence_ids] })),
  };
  return deepFreeze({ snapshot, change: { id: c.id, statement: c.statement, occurred_at: c.occurred_at,
    evidence_ids: [...c.evidence_ids], target_ids: [...c.target_ids] } });
}
export function limits(raw: Partial<Limits> = {}): Limits {
  const v = { ...DEFAULT_LIMITS, ...raw };
  if (!integer(v.concurrency, 1, 8) || !integer(v.max_requests, 0, 64)
    || !integer(v.request_timeout_ms, 1, 30_000) || !integer(v.total_timeout_ms, 1, 60_000)
    || !integer(v.max_request_bytes, 1, 128_000) || !integer(v.max_total_request_bytes, 1, 4_000_000)) {
    throw new ReflexError("invalid_input");
  }
  return Object.freeze(v);
}
export function thresholds(raw: Partial<Thresholds> = {}): Thresholds {
  const v = { ...DEFAULT_THRESHOLDS, ...raw };
  if (!Object.values(v).every(unit) || v.evidence_min < 0.5 || v.applicability_min < 0.5
    || v.relation_probability_min <= 0.5 || v.counterevidence_max >= 0.5) throw new ReflexError("invalid_input");
  return Object.freeze(v);
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
