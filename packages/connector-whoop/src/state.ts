import { createHash } from 'node:crypto';
import { KizukiError, isRfc3339, parseOAuthState, type OAuthState } from '@kizuki/core';
export const WHOOP_ID = 'kizuki.whoop';
export const CURSOR_SCHEMA = 'kizuki.whoop-cursor/v1';
export const RESOURCES = ['cycle', 'recovery', 'sleep', 'workout'] as const;
export type Resource = typeof RESOURCES[number];
export const FIELDS = ['metrics', 'activity'] as const;
export type Field = typeof FIELDS[number];
export interface Selection {
    resources: Resource[];
    fields: Field[];
    history_start: string;
}
export interface Plan {
    id: string;
    base: string | null;
    end: string;
    observed: string;
    entries: {
        key: string;
        hash: string;
    }[];
    issued: number;
}
export interface WhoopState {
    schema: 'kizuki.whoop-state/v1';
    oauth: OAuthState;
    selection: Selection;
    pending: Plan | null;
    retry_at: string | null;
}
export interface WhoopCursor {
    schema: typeof CURSOR_SCHEMA;
    account: string;
    selection: string;
    plan: string;
    offset: number;
}
export function failure(code = 'provider_error'): KizukiError {
    return new KizukiError(['rate_limited', 'unauthenticated', 'unreachable', 'misconfigured', 'not_supported', 'timeout'].includes(code) ? code as 'timeout' : 'unavailable', `WHOOP ${code}; check configured access and bounded history coverage`);
}
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw failure();
    return value as Record<string, unknown>;
}
export function instant(value: unknown): string {
    if (typeof value !== 'string' || value.length > 64 || !isRfc3339(value))
        throw failure();
    return value;
}
export function integerId(value: unknown): string {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        throw failure();
    return String(value);
}
export function accountId(value: unknown): string {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw failure();
    return value;
}
export function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function hash(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw failure();
    return value;
}
function selected<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > allowed.length || raw.some(v => !allowed.includes(v)) || new Set(raw).size !== raw.length)
        throw failure('misconfigured');
    return allowed.filter(x => raw.includes(x));
}
export function selection(raw: unknown): Selection {
    const value = object(raw);
    return {
        resources: selected(value.resources, RESOURCES), fields: selected(value.fields, FIELDS), history_start: instant(value.history_start)
    };
}
export function scopes(s: Selection): string[] {
    return ['offline', 'read:profile', ...s.resources.map(r => `read:${r === 'cycle' ? 'cycles' : r}`)];
}
export function encodeCursor(cursor: WhoopCursor): string {
    return JSON.stringify(cursor);
}
export function decodeCursor(raw: string): WhoopCursor {
    if (raw.length > 8192)
        throw failure('invalid_cursor');
    try {
        const x = object(JSON.parse(raw));
        if (x.schema !== CURSOR_SCHEMA || !Number.isSafeInteger(x.offset) || Number(x.offset) < 0 || Number(x.offset) > 1000 || Object.keys(x).sort().join(',') !== 'account,offset,plan,schema,selection')
            throw failure();
        return {
            schema: CURSOR_SCHEMA, account: accountId(x.account), selection: hash(x.selection), plan: hash(x.plan), offset: Number(x.offset)
        };
    }
    catch {
        throw failure('invalid_cursor');
    }
}
export function parseState(bytes: Uint8Array): WhoopState {
    if (bytes.byteLength > 384 * 1024)
        throw failure('invalid_state');
    try {
        const x = object(JSON.parse(new TextDecoder('utf-8', {
            fatal: true
        }).decode(bytes)));
        if (x.schema !== 'kizuki.whoop-state/v1')
            throw failure();
        const s = selection(x.selection), oauth = parseOAuthState(new TextEncoder().encode(JSON.stringify(x.oauth)), WHOOP_ID);
        if (oauth.provider !== WHOOP_ID || !scopes(s).every(scope => oauth.tokens.scope.split(' ').includes(scope)))
            throw failure();
        accountId(oauth.account.id);
        let pending: Plan | null = null;
        if (x.pending !== null) {
            const p = object(x.pending);
            if (!Array.isArray(p.entries) || p.entries.length > 1000 || !Number.isSafeInteger(p.issued) || Number(p.issued) < 0 || Number(p.issued) > p.entries.length || !(p.base === null || typeof p.base === 'string'))
                throw failure();
            const entries = p.entries.map(raw => {
                const e = object(raw);
                if (typeof e.key !== 'string' || e.key.length > 160 || !/^whoop:[1-9][0-9]*:(cycle|recovery|sleep|workout):[a-z0-9-]+$/.test(e.key))
                    throw failure();
                return {
                    key: e.key, hash: hash(e.hash)
                };
            });
            if (new Set(entries.map(e => e.key)).size !== entries.length)
                throw failure();
            if (p.base !== null)
                decodeCursor(p.base);
            pending = {
                id: hash(p.id), base: p.base, end: instant(p.end), observed: instant(p.observed), entries, issued: Number(p.issued)
            };
            if (pending.id !== planId(pending, oauth.account.id, s))
                throw failure();
        }
        return {
            schema: 'kizuki.whoop-state/v1', oauth, selection: s, pending, retry_at: x.retry_at === null ? null : instant(x.retry_at)
        };
    }
    catch {
        throw failure('invalid_state');
    }
}
export function planId(p: Omit<Plan, 'id'>, account: string, s: Selection): string {
    return digest({
        base: p.base, end: p.end, observed: p.observed, entries: p.entries, account, selection: s
    });
}
export function encodeState(state: WhoopState): Uint8Array {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    parseState(bytes);
    return bytes;
}
