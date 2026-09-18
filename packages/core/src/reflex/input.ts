import { REFLEX_LIMITS } from "./types";
import type { ReflexAssumption, ReflexRequest } from "./types";

/** Fixed errors contain no statements, source IDs, or provider messages. */
export function invalidInput(): never { throw new RangeError("invalid Reflex request"); }
export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value) || Object.keys(value).length > keys.length) invalidInput();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!keys.includes(key) || !Object.hasOwn(property, "value")) invalidInput();
    copy[key] = property.value;
  }
  return copy;
}
export const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || bytes(value) > max || CONTROLS.test(value) || new TextDecoder().decode(new TextEncoder().encode(value)) !== value || value.trim().length === 0) invalidInput();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalidInput();
  for (let i = 0; i < value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (item === undefined || !Object.hasOwn(item, "value")) invalidInput();
  }
  return value;
}
export function parseReflexRequest(value: unknown): Required<ReflexRequest> {
  const root = dataRecord(value, ["assumptions", "event_ids", "max_age_ms"]);
  const assumptions: ReflexAssumption[] = list(root.assumptions, REFLEX_LIMITS.assumptions).map(value => {
    const row = dataRecord(value, ["id", "statement", "importance"]);
    const id = text(row.id, 48);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalidInput();
    const importance = row.importance === undefined ? "normal" : row.importance;
    if (importance !== "normal" && importance !== "critical") invalidInput();
    return Object.freeze({ id, statement: text(row.statement, REFLEX_LIMITS.statement_bytes), importance });
  });
  if (assumptions.length === 0 || new Set(assumptions.map(a => a.id)).size !== assumptions.length) invalidInput();
  const ids = list(root.event_ids, REFLEX_LIMITS.events).map(value => {
    const id = text(value, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalidInput();
    return id;
  });
  if (new Set(ids).size !== ids.length) invalidInput();
  const age = root.max_age_ms === undefined ? REFLEX_LIMITS.default_age_ms : root.max_age_ms;
  if (typeof age !== "number" || !Number.isSafeInteger(age) || age < 1 || age > REFLEX_LIMITS.max_age_ms) invalidInput();
  return Object.freeze({ assumptions: Object.freeze(assumptions), event_ids: Object.freeze(ids), max_age_ms: age });
}
