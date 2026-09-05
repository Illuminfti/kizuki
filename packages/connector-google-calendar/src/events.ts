import { isRfc3339, validateEventInput, type CaptureEventInput } from '@kizuki/core';
import { ID, id, object, failure, type Field } from './state';
function text(value: unknown, max = 16384): string { if (value === undefined)
    return ''; if (typeof value !== 'string' || Buffer.byteLength(value) > max)
    throw failure(); return value; }
function time(value: unknown): Record<string, string> | null { if (value === undefined)
    return null; const v = object(value); const result: Record<string, string> = {}; if (v.date !== undefined) {
    const date = text(v.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || v.dateTime !== undefined)
        throw failure();
    result.date = date;
}
else {
    const dt = text(v.dateTime, 64);
    if (!isRfc3339(dt) && !(typeof v.timeZone === 'string' && isRfc3339(dt + 'Z') && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(dt)))
        throw failure();
    result.dateTime = dt;
} if (v.timeZone !== undefined) {
    const zone = text(v.timeZone, 128);
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
    }
    catch {
        throw failure();
    }
    result.timeZone = zone;
} return result; }
export function projection(selected: readonly Field[]): string { const base = ['id', 'etag', 'status', 'updated', 'start', 'end', 'recurrence', 'recurringEventId', 'originalStartTime']; for (const field of selected)
    base.push(field === 'attendees' ? 'attendees(email,displayName,responseStatus),attendeesOmitted' : field === 'attachments' ? 'attachments(fileId,title,mimeType)' : field); return `nextPageToken,nextSyncToken,items(${base.join(',')})`; }
export function event(account: string, calendar: string, raw: Record<string, unknown>, observed: string, selected: readonly Field[], cancelAt: string): CaptureEventInput {
    const eventId = id(raw.id);
    if (!['confirmed', 'tentative', 'cancelled'].includes(raw.status as string))
        throw failure();
    const deleted = raw.status === 'cancelled';
    const updated = raw.updated === undefined ? null : text(raw.updated, 64);
    if (updated !== null && !isRfc3339(updated) || !deleted && updated === null)
        throw failure();
    const recurrence = raw.recurrence === undefined ? [] : raw.recurrence;
    if (!Array.isArray(recurrence) || recurrence.length > 32 || recurrence.some(v => typeof v !== 'string' || Buffer.byteLength(v) > 2048))
        throw failure();
    const metadata: Record<string, unknown> = { provider: 'google-calendar', calendar_id: calendar, event_id: eventId, status: raw.status, provider_etag: raw.etag === undefined ? null : text(raw.etag, 1024), provider_updated_at: updated, occurred_at_semantics: updated === null ? 'cancellation_first_observed' : 'provider_updated', provider_deleted_at: null, recurrence_expanded: false, schedule: { start: time(raw.start), end: time(raw.end), end_semantics: 'exclusive', recurrence, recurring_event_id: raw.recurringEventId === undefined ? null : id(raw.recurringEventId), original_start: time(raw.originalStartTime) } };
    const subjects: CaptureEventInput['subjects'] = [], attachments: CaptureEventInput['attachments'] = [];
    const lines: string[] = [];
    if (!deleted) {
        for (const field of ['summary', 'description', 'location'] as const)
            if (selected.includes(field) && raw[field] !== undefined)
                lines.push(`${field}: ${text(raw[field])}`);
        if (selected.includes('attendees')) {
            const attendees = raw.attendees ?? [];
            if (!Array.isArray(attendees) || attendees.length > 64)
                throw failure();
            metadata.attendees_omitted = raw.attendeesOmitted === true;
            metadata.attendees = attendees.map(value => { const a = object(value); const email = id(a.email); subjects.push({ subject_id: 'email:' + email, role: 'about', ...(a.displayName === undefined ? {} : { display_name: text(a.displayName, 512) }) }); return { email, response_status: text(a.responseStatus, 32) }; });
        }
        if (selected.includes('attachments')) {
            const values = raw.attachments ?? [];
            if (!Array.isArray(values) || values.length > 64)
                throw failure();
            for (const value of values) {
                const a = object(value);
                attachments.push({ attachment_id: id(a.fileId), filename: text(a.title, 1024), media_type: text(a.mimeType, 256) || 'application/octet-stream' });
            }
            metadata.attachment_bodies = 'unsupported';
            metadata.attachment_sizes = 'unknown';
        }
    }
    const result: CaptureEventInput = { schema: 'kizuki.event/v1', connector_id: ID, source_record_id: Buffer.from(JSON.stringify([account, calendar, eventId])).toString('base64url'), kind: 'calendar_event', occurred_at: updated ?? cancelAt, observed_at: observed, text: lines.join('\n'), subjects, attachments, deleted, sensitivity_hint: 'private', metadata };
    if (!validateEventInput(result).ok)
        throw failure();
    return result;
}
