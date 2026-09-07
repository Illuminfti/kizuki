import { expect, test } from 'bun:test';
import { accept, validateEventInput } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { CalendarFixture } from '../src/testing';
import { createGoogleCalendarConnector } from '../src';
import { parseState, encodeState } from '../src/state';
const schedule = (event: { metadata: Record<string, unknown> }) => event.metadata.schedule as Record<string, unknown>;
const zoned = (dateTime: string) => ({ dateTime, timeZone: 'America/New_York' });
const attendee = (i: number) => ({ email: `guest${i}@synthetic.invalid`, displayName: `Guest ${i}`, responseStatus: 'accepted' });
const instance = { id: 'recurring1_20240208T140000Z', status: 'confirmed', etag: '"v1"', updated: '2024-01-02T13:00:00Z', summary: 'Synthetic moved instance', recurringEventId: 'recurring1', originalStartTime: zoned('2024-02-08T09:00:00-05:00'), start: zoned('2024-02-08T11:00:00-05:00'), end: zoned('2024-02-08T12:00:00-05:00') };
/** Install before connecting: a connector captures the fixture transport at construction. Identity requests and `null` answers keep the fixture transport. */
function route(f: CalendarFixture, calendar: (request: Request) => Response | null) {
    const base = f.fetch;
    f.fetch = async (request) => {
        const answer = new URL(request.url).hostname === 'openidconnect.googleapis.com' ? null : calendar(request);
        if (answer === null)
            return base(request);
        f.calls.push(request.url);
        return answer;
    };
}
test('timed event keeps exact dateTime strings and zone while occurred_at is the provider revision', async () => {
    const f = new CalendarFixture(), b = await (await f.connected()).backfill(null), timed = b.events[1]!;
    expect(schedule(timed).start).toEqual(zoned('2024-02-01T09:00:00-05:00'));
    expect(schedule(timed).end).toEqual(zoned('2024-02-01T10:00:00-05:00'));
    expect(schedule(timed).end_semantics).toBe('exclusive');
    expect(timed.occurred_at).toBe('2024-01-02T12:00:00Z');
    expect(timed.metadata.occurred_at_semantics).toBe('provider_updated');
    expect(timed.metadata.provider_updated_at).toBe('2024-01-02T12:00:00Z');
});
test('recurring master keeps rules verbatim unexpanded and an exception instance keeps its parent link', async () => {
    const f = new CalendarFixture();
    f.rows = [f.rows[1]!, instance];
    const b = await (await f.connected()).backfill(null), master = b.events[0]!, exception = b.events[1]!;
    expect(b.detail).toContain('recurrence_not_expanded');
    expect(master.metadata.recurrence_expanded).toBe(false);
    expect(schedule(master).recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=3']);
    expect(schedule(master).recurring_event_id).toBeNull();
    expect(schedule(master).original_start).toBeNull();
    expect(exception.metadata.recurrence_expanded).toBe(false);
    expect(schedule(exception).recurrence).toEqual([]);
    expect(schedule(exception).recurring_event_id).toBe('recurring1');
    expect(schedule(exception).original_start).toEqual(zoned('2024-02-08T09:00:00-05:00'));
    expect(schedule(exception).start).toEqual(zoned('2024-02-08T11:00:00-05:00'));
    expect(exception.source_record_id).not.toBe(master.source_record_id);
    expect(exception.subjects[0]!.subject_id).not.toBe(master.subjects[0]!.subject_id);
});
test('a schedule-only edit stores a new version under the same source record', async () => {
    const f = new CalendarFixture(), c = await f.connected(), db = openLedger(':memory:');
    try {
        const first = await c.backfill(null);
        expect(first.events.map(e => accept(db, e).status)).toEqual(['stored', 'stored']);
        f.advance();
        f.version++;
        Object.assign(f.rows[1]!, { etag: '"v2"', updated: '2024-01-04T00:00:00Z', start: zoned('2024-02-01T14:00:00-05:00'), end: zoned('2024-02-01T15:00:00-05:00') });
        const second = await c.sync(first.cursor);
        expect(second.events).toHaveLength(2);
        expect(second.events.map(e => accept(db, e).status)).toEqual(['duplicate', 'stored']);
        expect(second.events[1]!.source_record_id).toBe(first.events[1]!.source_record_id);
        expect(second.events[1]!.occurred_at).toBe('2024-01-04T00:00:00Z');
        expect(schedule(second.events[1]!).start).toEqual(zoned('2024-02-01T14:00:00-05:00'));
        expect(second.events[1]!.text).toBe(first.events[1]!.text);
    }
    finally {
        db.close();
    }
});
test('selected attendees keep the provider cap of 64 with omission reported and email subjects', async () => {
    const f = new CalendarFixture();
    f.rows[0]!.attendees = Array.from({ length: 64 }, (_, i) => attendee(i));
    f.rows[0]!.attendeesOmitted = true;
    const b = await (await f.connected()).backfill(null), event = b.events[0]!;
    expect(new URL(f.calls.at(-1)!).searchParams.get('maxAttendees')).toBe('64');
    expect(event.metadata.attendees_omitted).toBe(true);
    expect(event.metadata.attendees).toHaveLength(64);
    expect((event.metadata.attendees as unknown[])[5]).toEqual({ email: 'guest5@synthetic.invalid', response_status: 'accepted' });
    expect(event.subjects).toHaveLength(65);
    expect(event.subjects[0]!.subject_id).toStartWith('google-calendar-event:');
    expect(event.subjects[6]).toEqual({ subject_id: 'email:guest5@synthetic.invalid', role: 'about', display_name: 'Guest 5' });
    expect(b.events[1]!.metadata.attendees).toEqual([]);
    expect(b.events[1]!.metadata.attendees_omitted).toBe(false);
});
test('a provider page exceeding the attendee cap refuses without publishing a plan', async () => {
    const f = new CalendarFixture();
    f.rows[0]!.attendees = Array.from({ length: 70 }, (_, i) => attendee(i));
    const before = f.state.slice(), b = await (await f.connected()).backfill(null);
    expect(b.status).toBe('unavailable');
    expect(b.events).toEqual([]);
    expect(b.cursor).toBeNull();
    expect(f.state).toEqual(before);
});
test('unselected attendees leave no attendee metadata, subjects, or projection', async () => {
    const f = new CalendarFixture(), s = parseState(f.state);
    s.fields = ['summary'];
    f.state = encodeState(s);
    f.rows[0]!.attendees = [attendee(1)];
    f.rows[0]!.attendeesOmitted = true;
    const c = createGoogleCalendarConnector({ client: { id: 'synthetic-client' }, secret_ref: 'file:synthetic', calendar_id: f.calendar, fields: ['summary'] }, { fetch: f.fetch, persist: f.persist, now: f.now });
    await c.connect(async () => new TextDecoder().decode(f.state));
    const b = await c.backfill(null);
    expect(new URL(f.calls.at(-1)!).searchParams.get('fields')).not.toContain('attendees');
    expect(Object.keys(b.events[0]!.metadata).filter(k => k.startsWith('attendee'))).toEqual([]);
    expect(b.events[0]!.subjects).toHaveLength(1);
    expect(JSON.stringify(b.events)).not.toContain('synthetic.invalid');
});
test('documented 403 user rate limit persists a cooldown that outlives the session', async () => {
    const f = new CalendarFixture();
    route(f, () => Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded', message: 'PRIVATE_PROVIDER_SECRET' }] } }, { status: 403, headers: { 'Retry-After': '120' } }));
    const c = await f.connected(), b = await c.backfill(null);
    expect(b.status).toBe('unavailable');
    expect(b.detail).toContain('rate_limited');
    expect(b.detail).not.toContain('PRIVATE_PROVIDER_SECRET');
    expect(b.detail).not.toContain('userRateLimitExceeded');
    expect(b.events).toEqual([]);
    expect(b.cursor).toBeNull();
    expect((await c.health()).state).toBe('rate_limited');
    const state = parseState(f.state);
    expect(state.retry_not_before).toBe('2024-01-03T00:02:00.000Z');
    expect(state.pending).toBeNull();
    const calls = f.calls.length;
    await expect(f.connected()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f.calls).toHaveLength(calls);
    expect(f.state).toEqual(encodeState(state));
});
test('a page carrying both nextPageToken and nextSyncToken is refused without advancing the cursor', async () => {
    const f = new CalendarFixture();
    let conflicting = false;
    route(f, () => conflicting ? Response.json({ items: [f.rows[0]], nextPageToken: '20', nextSyncToken: 's2' }) : null);
    const c = await f.connected(), first = await c.backfill(null), witness = parseState(f.state);
    conflicting = true;
    const b = await c.sync(first.cursor);
    expect(b.status).toBe('unavailable');
    expect(b.events).toEqual([]);
    expect(b.cursor).toBe(first.cursor);
    expect(parseState(f.state)).toEqual(witness);
    expect((await c.health()).state).toBe('degraded');
});
test('every emitted live event is private and valid at the core ingress', async () => {
    const f = new CalendarFixture();
    f.rows[0]!.attendees = [attendee(1)];
    f.rows[0]!.attachments = [{ fileId: 'synthetic-file', title: 'fixture', mimeType: 'text/plain' }];
    f.rows.push(instance, { id: 'gone1', status: 'cancelled' }, { id: 'gone2', status: 'cancelled', updated: '2024-01-02T14:00:00Z' });
    const b = await (await f.connected()).backfill(null);
    expect(b.events).toHaveLength(5);
    for (const event of b.events) {
        expect(event.sensitivity_hint).toBe('private');
        expect(validateEventInput(event)).toMatchObject({ ok: true });
    }
    expect(b.events.map(e => e.deleted)).toEqual([false, false, false, true, true]);
});
test('410 while replaying a witnessed page refuses as a snapshot gap and keeps the witness', async () => {
    const f = new CalendarFixture(), first = await (await f.connected()).backfill(null);
    f.advance();
    f.version++;
    const lost = await (await f.connected(async (bytes) => { f.state = bytes.slice(); throw Error('synthetic lost state response'); })).sync(first.cursor);
    expect(lost.status).toBe('unavailable');
    const witness = parseState(f.state).pending!;
    expect(witness.fingerprints).toHaveLength(2);
    f.expired = true;
    const c = await f.connected(), b = await c.sync(first.cursor);
    expect(b.status).toBe('unavailable');
    expect(b.detail).toContain('snapshot_gap_unresolved');
    expect(b.events).toEqual([]);
    expect(b.cursor).toBe(first.cursor);
    expect(parseState(f.state).pending).toEqual(witness);
    expect(f.expired).toBe(false);
    expect((await c.sync(first.cursor)).events).toHaveLength(2);
});
