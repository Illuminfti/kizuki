import { createHash } from 'node:crypto';
import { KizukiError, isRfc3339, parseOAuthState, MAX_CONNECTION_STATE_BYTES, MAX_CURSOR_BYTES, type OAuthState } from '@kizuki/core';
export const ID = 'kizuki.google-calendar', CURSOR = 'kizuki.google-calendar-cursor/v1';
export const SCOPES = Object.freeze(['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly']);
export const FIELDS = Object.freeze(['summary', 'description', 'location', 'attendees', 'attachments'] as const);
export type Field = typeof FIELDS[number];
export interface Cursor {
    schema: typeof CURSOR;
    account: string;
    calendar: string;
    sync: string | null;
    page: string | null;
    count: number;
    gap: boolean;
}
export interface Plan {
    input: string;
    request: Cursor;
    next: Cursor;
    observed_at: string;
    fingerprints: string[];
}
export interface State {
    schema: 'kizuki.google-calendar-state/v1';
    oauth: OAuthState;
    calendar: string;
    fields: Field[];
    pending: Plan | null;
    anchors: Record<string, string>;
    retry_not_before: string | null;
}
export function failure(code: ConstructorParameters<typeof KizukiError>[0] = 'source_schema'): KizukiError { return new KizukiError(code, `Google Calendar ${code}; check explicit enrollment or bounded source coverage`); }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure(); return value as Record<string, unknown>; }
function exact(value: unknown, keys: string): Record<string, unknown> { const row = object(value); if (Object.keys(row).sort().join() !== keys.split(',').sort().join())
    throw failure(); return row; }
export function id(value: unknown): string { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value))
    throw failure(); return value; }
export function calendar(value: unknown): string { const valueId = id(value); if (valueId.toLowerCase() === 'primary')
    throw failure('misconfigured'); return valueId; }
export function fields(value: unknown): Field[] { if (!Array.isArray(value) || value.some(v => !FIELDS.includes(v)) || new Set(value).size !== value.length)
    throw failure('misconfigured'); return FIELDS.filter(v => value.includes(v)); }
function token(value: unknown): string | null { if (value === null)
    return null; if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048 || /[\x00-\x20\x7f]/.test(value))
    throw failure(); return value; }
function cursor(value: unknown, account: string, selectedCalendar: string): Cursor { const row = exact(value, 'schema,account,calendar,sync,page,count,gap'); if (row.schema !== CURSOR || row.account !== account || row.calendar !== selectedCalendar || !Number.isSafeInteger(row.count) || (row.count as number) < 0 || (row.count as number) > 1000 || typeof row.gap !== 'boolean')
    throw failure(); return { schema: CURSOR, account, calendar: selectedCalendar, sync: token(row.sync), page: token(row.page), count: row.count as number, gap: row.gap }; }
export function encodeCursor(value: Cursor): string { const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_CURSOR_BYTES)
    throw failure(); return text; }
export function decodeCursor(text: string, account: string, selectedCalendar: string): Cursor { try {
    if (Buffer.byteLength(text) > MAX_CURSOR_BYTES)
        throw failure();
    return cursor(JSON.parse(text), account, selectedCalendar);
}
catch {
    throw failure();
} }
export function parseState(bytes: Uint8Array): State {
    try {
        if (bytes.byteLength > MAX_CONNECTION_STATE_BYTES)
            throw failure();
        const row = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 'schema,oauth,calendar,fields,pending,anchors,retry_not_before');
        if (row.schema !== 'kizuki.google-calendar-state/v1')
            throw failure();
        const oauth = parseOAuthState(new TextEncoder().encode(JSON.stringify(row.oauth)), ID), selectedCalendar = calendar(row.calendar), selectedFields = fields(row.fields);
        id(oauth.account.id);
        if (!SCOPES.every(scope => oauth.tokens.scope.split(/\s+/).includes(scope)))
            throw failure('unauthenticated');
        const anchors = object(row.anchors);
        if (Object.keys(anchors).length > 1000 || Object.entries(anchors).some(([key, value]) => !/^([a-f0-9]{64})$/.test(key) || !isRfc3339(value)))
            throw failure();
        if (row.retry_not_before !== null && !isRfc3339(row.retry_not_before))
            throw failure();
        let pending: Plan | null = null;
        if (row.pending !== null) {
            const p = exact(row.pending, 'input,request,next,observed_at,fingerprints');
            if (typeof p.input !== 'string' || !/^[a-f0-9]{64}$/.test(p.input) || !isRfc3339(p.observed_at) || !Array.isArray(p.fingerprints) || p.fingerprints.length > 20 || p.fingerprints.some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)))
                throw failure();
            pending = { input: p.input, request: cursor(p.request, oauth.account.id, selectedCalendar), next: cursor(p.next, oauth.account.id, selectedCalendar), observed_at: p.observed_at, fingerprints: p.fingerprints as string[] };
        }
        if (Buffer.byteLength(JSON.stringify({ pending, anchors })) > 128 * 1024)
            throw failure();
        return { schema: 'kizuki.google-calendar-state/v1', oauth, calendar: selectedCalendar, fields: selectedFields, pending, anchors: anchors as Record<string, string>, retry_not_before: row.retry_not_before as string | null };
    }
    catch {
        throw failure();
    }
}
export function encodeState(state: State): Uint8Array { const bytes = new TextEncoder().encode(JSON.stringify(state)); parseState(bytes); return bytes; }

/** Noncredential native host projection; no tokens, page content or cursor material. */
export function inspectGoogleCalendarState(bytes: Uint8Array): {account_id:string;calendar_id:string;fields:Field[];has_pending:boolean} {
 const state=parseState(bytes);return{account_id:state.oauth.account.id,calendar_id:state.calendar,fields:[...state.fields],has_pending:state.pending!==null};
}
/** Reauthorization cannot orphan a cursor, observation anchor, or provider cooldown. */
export function assertSameGoogleCalendarIdentity(previous:Uint8Array,candidate:Uint8Array):void{
 const before=parseState(previous),after=parseState(candidate);
 if(before.oauth.account.id!==after.oauth.account.id||before.calendar!==after.calendar||digest(before.fields)!==digest(after.fields)||digest(before.pending)!==digest(after.pending)||digest(before.anchors)!==digest(after.anchors)||before.retry_not_before!==after.retry_not_before)throw failure('unauthenticated');
}
