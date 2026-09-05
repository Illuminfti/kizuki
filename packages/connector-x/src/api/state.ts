import { createHash } from "node:crypto";
import { KizukiError, isPlainObject, isRfc3339, parseOAuthState, type OAuthState } from "@kizuki/core";

export const X_API_CONNECTOR_ID = "kizuki.x";
export const X_API_CURSOR_SCHEMA = "kizuki.x-api-cursor/v1";
export const X_API_STATE_SCHEMA = "kizuki.x-api-state/v1";
export const X_API_SCOPES = ["tweet.read", "users.read", "offline.access"] as const;
export const MAX_PAGE_POSTS = 100;
export const MAX_WALK_PAGES = 64;
export const OPTIONAL_FIELDS = ["relationships", "links", "media"] as const;
export type XApiField = typeof OPTIONAL_FIELDS[number];
export interface XApiSelection { fields: XApiField[]; history_start: string; wire_profile: "tweet-v2" }
const RULES = ["misconfigured", "unauthenticated", "unavailable", "timeout", "unreachable", "invalid_state", "invalid_cursor", "identity_mismatch", "provider_error", "partial_response", "response_limit", "batch_limit", "request_limit", "pagination_gap", "snapshot_changed", "rate_limited", "permission_denied", "billing_required", "not_supported"] as const;
export type FailureRule = typeof RULES[number];
class XApiFailure extends KizukiError {
  constructor(readonly rule: FailureRule) {
    super(["misconfigured", "unauthenticated", "timeout", "unreachable", "rate_limited", "not_supported"].includes(rule) ? rule as "timeout" : "unavailable", `X API ${rule}; bounded own-post capture could not complete`);
  }
}
export function failure(rule: FailureRule = "provider_error"): KizukiError { return new XApiFailure(rule); }
export function failureRule(error: unknown): FailureRule | null { return error instanceof XApiFailure && RULES.includes(error.rule) ? error.rule : null; }
export function normalizedFailure(error: unknown): KizukiError { return failure(failureRule(error) ?? "unavailable"); }
export function object(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw failure();
  return value;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw failure();
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw failure();
  return value;
}
export function instant(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !isRfc3339(value) || !Number.isFinite(Date.parse(value))) throw failure();
  return value;
}
/** Preserve sub-millisecond ordering within the accepted non-leap RFC3339 grammar. */
export function compareInstants(left: string, right: string): number {
  const a = Date.parse(instant(left)), b = Date.parse(instant(right));
  if (a !== b) return a < b ? -1 : 1;
  const tail = (value: string) => (/\.(\d+)(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "").slice(3);
  const af = tail(left), bf = tail(right), width = Math.max(af.length, bf.length);
  return af.padEnd(width, "0") < bf.padEnd(width, "0") ? -1 : af.padEnd(width, "0") > bf.padEnd(width, "0") ? 1 : 0;
}
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure();
  return value;
}
export function token(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 2048 || /[\x00-\x20\x7f]/.test(value)) throw failure("pagination_gap");
  return value;
}
export function selection(raw: unknown): XApiSelection {
  try {
    const value = object(raw); exact(value, ["fields", "history_start", "wire_profile"]);
    if (!Array.isArray(value.fields) || value.fields.length > OPTIONAL_FIELDS.length || new Set(value.fields).size !== value.fields.length ||
      value.fields.some(field => !OPTIONAL_FIELDS.includes(field)) || value.wire_profile !== "tweet-v2") throw failure();
    const suppliedStart = instant(value.history_start), start = new Date(suppliedStart).toISOString();
    // A canonical millisecond query must never widen the owner's lower bound.
    if (compareInstants(suppliedStart, start) !== 0) throw failure();
    if (start < "2010-11-06T00:00:00.000Z") throw failure();
    return { fields: OPTIONAL_FIELDS.filter(field => (value.fields as unknown[]).includes(field)), history_start: start, wire_profile: "tweet-v2" };
  } catch { throw failure("misconfigured"); }
}
export interface XApiCursor {
  schema: typeof X_API_CURSOR_SCHEMA;
  account: string;
  selection: string;
  phase: "walk" | "idle";
  committed: string | null;
  lower: string | null;
  end: string;
  newest: string | null;
  next: string | null;
  pages: number;
  seen: string[];
  restarts: number;
}
export function encodeCursor(cursor: XApiCursor): string {
  const encoded = JSON.stringify(cursor);
  if (Buffer.byteLength(encoded) > 8192) throw failure("invalid_cursor");
  return encoded;
}
export function parseCursor(raw: string): XApiCursor {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) throw failure();
    const value = object(JSON.parse(raw));
    exact(value, ["schema", "account", "selection", "phase", "committed", "lower", "end", "newest", "next", "pages", "seen", "restarts"]);
    if (value.schema !== X_API_CURSOR_SCHEMA || !["walk", "idle"].includes(String(value.phase)) ||
      !Number.isSafeInteger(value.pages) || Number(value.pages) < 0 || Number(value.pages) > MAX_WALK_PAGES ||
      !Number.isInteger(value.restarts) || Number(value.restarts) < 0 || Number(value.restarts) > 1 ||
      !Array.isArray(value.seen) || value.seen.length > MAX_WALK_PAGES || new Set(value.seen).size !== value.seen.length) throw failure();
    const cursor: XApiCursor = { schema: X_API_CURSOR_SCHEMA, account: id(value.account), selection: hash(value.selection), phase: value.phase as "walk" | "idle",
      committed: value.committed === null ? null : id(value.committed), lower: value.lower === null ? null : id(value.lower), end: instant(value.end),
      newest: value.newest === null ? null : id(value.newest), next: value.next === null ? null : token(value.next), pages: Number(value.pages),
      seen: value.seen.map(hash), restarts: Number(value.restarts) };
    if (cursor.phase === "idle" ? cursor.next !== null || cursor.lower !== null || cursor.newest !== null || cursor.pages !== 0 || cursor.seen.length !== 0 || cursor.restarts !== 0 :
      cursor.next === null || cursor.pages < 1 || cursor.seen.length < 1 || cursor.seen.length > cursor.pages ||
      cursor.restarts === 0 && cursor.seen.length !== cursor.pages || !cursor.seen.includes(digest(cursor.next)) || cursor.lower !== cursor.committed) throw failure();
    if (cursor.newest !== null && cursor.committed !== null && BigInt(cursor.newest) <= BigInt(cursor.committed)) throw failure();
    return cursor;
  } catch { throw failure("invalid_cursor"); }
}
export interface XApiPlan { id: string; base: string | null; next: string; observed: string; entries: { id: string; hash: string }[] }
export interface XApiState {
  schema: typeof X_API_STATE_SCHEMA;
  app: string;
  oauth: OAuthState;
  selection: XApiSelection;
  checkpoint: string | null;
  pending: XApiPlan | null;
  retry_at: string | null;
  revocation: "active" | "pending" | "revoked";
}
export function planDigest(plan: Omit<XApiPlan, "id">): string { return digest(plan); }
export function parseState(bytes: Uint8Array): XApiState {
  try {
    if (bytes.byteLength > 256 * 1024) throw failure();
    const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    exact(value, ["schema", "app", "oauth", "selection", "checkpoint", "pending", "retry_at", "revocation"]);
    if (value.schema !== X_API_STATE_SCHEMA || !["active", "pending", "revoked"].includes(String(value.revocation))) throw failure();
    const selected = selection(value.selection), oauth = parseOAuthState(JSON.stringify(value.oauth), X_API_CONNECTOR_ID);
    id(oauth.account.id);
    if (!X_API_SCOPES.every(scope => oauth.tokens.scope.split(/\s+/).includes(scope)) || oauth.tokens.refresh_token === null ||
      [oauth.tokens.access_token, oauth.tokens.refresh_token].some(value => Buffer.byteLength(value) > 8192 || /[\x00-\x20\x7f]/.test(value))) throw failure();
    const checkedCursor = (raw: unknown): string => {
      if (typeof raw !== "string") throw failure();
      const cursor = parseCursor(raw);
      if (cursor.account !== oauth.account.id || cursor.selection !== digest(selected) || compareInstants(cursor.end, selected.history_start) < 0) throw failure();
      return raw;
    };
    const checkpoint = value.checkpoint === null ? null : checkedCursor(value.checkpoint);
    let pending: XApiPlan | null = null;
    if (value.pending !== null) {
      const raw = object(value.pending); exact(raw, ["id", "base", "next", "observed", "entries"]);
      if (!Array.isArray(raw.entries) || raw.entries.length > MAX_PAGE_POSTS || raw.base !== checkpoint) throw failure();
      const draft = { base: checkpoint, next: checkedCursor(raw.next), observed: instant(raw.observed), entries: raw.entries.map(item => {
        const entry = object(item); exact(entry, ["id", "hash"]);
        return { id: id(entry.id), hash: hash(entry.hash) };
      }) };
      if (new Set(draft.entries.map(entry => entry.id)).size !== draft.entries.length || raw.id !== planDigest(draft) || draft.next === draft.base) throw failure();
      pending = { id: hash(raw.id), ...draft };
    }
    return { schema: X_API_STATE_SCHEMA, app: hash(value.app), oauth, selection: selected, checkpoint, pending, retry_at: value.retry_at === null ? null : instant(value.retry_at),
      revocation: value.revocation as XApiState["revocation"] };
  } catch { throw failure("invalid_state"); }
}
export function encodeState(state: XApiState): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(state)); parseState(bytes); return bytes;
}
