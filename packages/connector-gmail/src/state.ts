import { createHash } from "node:crypto";
import { KizukiError, MAX_CURSOR_BYTES, MAX_CONNECTION_STATE_BYTES, parseOAuthState, isRfc3339, type OAuthState } from "@kizuki/core";
export const GMAIL_CONNECTOR_ID = "kizuki.gmail";
export const GMAIL_CURSOR_SCHEMA = "kizuki.gmail-cursor/v1";
export const GMAIL_SCOPES = Object.freeze(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]);
export const MAX_PLAN_BYTES = 128 * 1024;
export type Field = "text" | "subjects" | "attachments" | "headers" | "labels";
export const FIELDS: readonly Field[] = Object.freeze(["text", "subjects", "attachments", "headers", "labels"]);
export interface GmailCursor {
    schema: typeof GMAIL_CURSOR_SCHEMA;
    account: string;
    phase: "backfill" | "sync";
    anchor: string;
    page: string | null;
    count: number;
    gap: boolean;
    capped: boolean;
    unresolved: boolean;
    plan: string | null;
    offset: number;
}
export interface Change {
    id: string;
    deleted: boolean;
    history: string;
}
export interface Plan {
    input: string;
    base: GmailCursor;
    next: GmailCursor;
    observed_at: string;
    items: Change[];
    /** One bounded batch, persisted before any of its events may leave the connector. */
    fence: {
        offset: number;
        fingerprints: string[];
    } | null;
}
export interface GmailState {
    schema: "kizuki.gmail-state/v1";
    oauth: OAuthState;
    fields: Field[];
    pending: Plan | null;
}
export function failure(code: ConstructorParameters<typeof KizukiError>[0] = "source_schema"): KizukiError {
    return new KizukiError(code, `Gmail ${code}; check enrollment, permissions or bounded source coverage`);
}
export function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw failure();
    return value as Record<string, unknown>;
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    const record = object(value);
    if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)))
        throw failure();
    return record;
}
export function id(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value))
        throw failure();
    return value;
}
export function historyId(value: unknown): string {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,39}$/.test(value))
        throw failure();
    return value;
}
export function pageToken(value: unknown): string | null {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(value))
        throw failure();
    return value;
}
export function fields(value: unknown): Field[] {
    if (!Array.isArray(value) || value.length > FIELDS.length || new Set(value).size !== value.length || value.some(v => !FIELDS.includes(v)))
        throw failure("misconfigured");
    return FIELDS.filter(field => value.includes(field));
}
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Capturing another batch must not invalidate the cursor that can retry that batch. */
export function planIdentity(plan: Plan): string {
    const { fence: _fence, ...identity } = plan;
    return digest(identity);
}
function cursorValue(value: unknown, account: string): GmailCursor {
    const c = exact(value, ["schema", "account", "phase", "anchor", "page", "count", "gap", "capped", "unresolved", "plan", "offset"]);
    if (c.schema !== GMAIL_CURSOR_SCHEMA || c.account !== account || !["backfill", "sync"].includes(c.phase as string) || !Number.isSafeInteger(c.count) || (c.count as number) < 0 || (c.count as number) > 1000 || typeof c.gap !== "boolean" || typeof c.capped !== "boolean" || typeof c.unresolved !== "boolean" || !Number.isSafeInteger(c.offset) || (c.offset as number) < 0 || (c.offset as number) > 1000 || !(c.plan === null || typeof c.plan === "string" && /^[a-f0-9]{64}$/.test(c.plan)) || (c.plan === null && c.offset !== 0))
        throw failure();
    id(c.account);
    historyId(c.anchor);
    pageToken(c.page);
    return c as unknown as GmailCursor;
}
export function encodeCursor(cursor: GmailCursor): string {
    cursorValue(cursor, cursor.account);
    const result = JSON.stringify(cursor);
    if (Buffer.byteLength(result) > MAX_CURSOR_BYTES)
        throw failure();
    return result;
}
export function decodeCursor(value: string, account: string): GmailCursor {
    if (Buffer.byteLength(value) > MAX_CURSOR_BYTES)
        throw failure();
    try {
        return cursorValue(JSON.parse(value), account);
    }
    catch {
        throw failure();
    }
}
export function parseState(bytes: Uint8Array): GmailState {
    if (bytes.byteLength > MAX_CONNECTION_STATE_BYTES)
        throw failure();
    try {
        const s = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["schema", "oauth", "fields", "pending"]);
        if (s.schema !== "kizuki.gmail-state/v1")
            throw failure();
        const oauth = parseOAuthState(new TextEncoder().encode(JSON.stringify(s.oauth)), GMAIL_CONNECTOR_ID);
        id(oauth.account.id);
        if (!GMAIL_SCOPES.every(scope => oauth.tokens.scope.split(/\s+/).includes(scope)))
            throw failure("unauthenticated");
        const selected = fields(s.fields);
        let pending: Plan | null = null;
        if (s.pending !== null) {
            if (Buffer.byteLength(JSON.stringify(s.pending)) > MAX_PLAN_BYTES)
                throw failure();
            const p = exact(s.pending, ["input", "base", "next", "observed_at", "items", "fence"]);
            if (typeof p.input !== "string" || !/^[a-f0-9]{64}$/.test(p.input) || !isRfc3339(p.observed_at) || !Array.isArray(p.items) || p.items.length > 1000)
                throw failure();
            const base = cursorValue(p.base, oauth.account.id), next = cursorValue(p.next, oauth.account.id);
            if (base.plan !== null || next.plan !== null)
                throw failure();
            const items = p.items.map(item => {
                const c = exact(item, ["id", "deleted", "history"]);
                if (typeof c.deleted !== "boolean")
                    throw failure();
                return { id: id(c.id), deleted: c.deleted, history: historyId(c.history) };
            });
            if (new Set(items.map(c => c.id)).size !== items.length)
                throw failure();
            let fence: Plan["fence"] = null;
            if (p.fence !== null) {
                const f = exact(p.fence, ["offset", "fingerprints"]);
                if (!Number.isSafeInteger(f.offset) || (f.offset as number) < 0 || (f.offset as number) % 20 !== 0 ||
                    (f.offset as number) >= items.length || !Array.isArray(f.fingerprints) ||
                    f.fingerprints.length !== Math.min(20, items.length - (f.offset as number)) ||
                    f.fingerprints.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))
                    throw failure();
                fence = { offset: f.offset as number, fingerprints: f.fingerprints as string[] };
            }
            pending = { input: p.input, base, next, observed_at: p.observed_at, items, fence };
        }
        return { schema: "kizuki.gmail-state/v1", oauth, fields: selected, pending };
    }
    catch (error) {
        if (error instanceof KizukiError)
            throw error;
        throw failure();
    }
}
export function encodeState(state: GmailState): Uint8Array {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    parseState(bytes);
    return bytes;
}
