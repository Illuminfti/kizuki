import { expect, test } from 'bun:test';
import { validateEventInput, type CaptureEventInput } from '@kizuki/core';
import { createGoogleCalendarConnector } from '../src';
import { CalendarFixture } from '../src/testing';
import { FIELDS, encodeState, parseState } from '../src/state';

type CivilTime = {
    date?: string;
    dateTime?: string;
    timeZone?: string;
};

function scheduleOf(event: CaptureEventInput) {
    const value = event.metadata.schedule;
    expect(value).toEqual(expect.any(Object));
    return value as {
        start: CivilTime | null;
        end: CivilTime | null;
        end_semantics: string;
        recurrence: string[];
        recurring_event_id: string | null;
        original_start: CivilTime | null;
    };
}

function byEventId(events: CaptureEventInput[]) {
    return new Map(events.map(event => [event.metadata.event_id, event]));
}

async function capture(rows: Record<string, unknown>[]) {
    const fixture = new CalendarFixture();
    fixture.rows = rows;
    const batch = await (await fixture.connected()).backfill(null);
    expect(batch.status).toBeUndefined();
    expect(batch.events).toHaveLength(rows.length);
    for (const event of batch.events) {
        expect(validateEventInput(event).ok).toBe(true);
        expect(event.kind).toBe('calendar_event');
    }
    return { fixture, batch, events: batch.events };
}

test('zoned date-times retain offset or IANA zone and never become occurred_at', async () => {
    const winterStart = { dateTime: '2024-01-10T09:00:00-05:00', timeZone: 'America/New_York' };
    const summerStart = { dateTime: '2024-07-10T09:00:00-04:00', timeZone: 'America/New_York' };
    const localStart = { dateTime: '2024-02-01T09:00:00', timeZone: 'Europe/Zurich' };
    const { events } = await capture([
        { id: 'winter1', status: 'confirmed', updated: '2024-01-02T12:00:00Z', start: winterStart, end: { dateTime: '2024-01-10T10:00:00-05:00', timeZone: 'America/New_York' } },
        { id: 'summer1', status: 'confirmed', updated: '2024-01-02T13:00:00Z', start: summerStart, end: { dateTime: '2024-07-10T10:00:00-04:00', timeZone: 'America/New_York' } },
        { id: 'local1', status: 'confirmed', updated: '2024-01-02T14:00:00Z', start: localStart, end: { dateTime: '2024-02-01T10:00:00', timeZone: 'Europe/Zurich' } },
    ]);
    const eventsById = byEventId(events);
    const winter = scheduleOf(eventsById.get('winter1')!);
    const summer = scheduleOf(eventsById.get('summer1')!);
    const local = scheduleOf(eventsById.get('local1')!);
    expect(eventsById.get('winter1')!.occurred_at).toBe('2024-01-02T12:00:00Z');
    expect(eventsById.get('summer1')!.occurred_at).toBe('2024-01-02T13:00:00Z');
    expect(eventsById.get('local1')!.occurred_at).toBe('2024-01-02T14:00:00Z');
    expect(winter.start).toEqual(winterStart);
    expect(summer.start).toEqual(summerStart);
    expect(local.start).toEqual(localStart);
    expect(winter.end_semantics).toBe('exclusive');
    expect(winter.start).not.toHaveProperty('date');
});

test('all-day dates keep exclusive civil days even when a provider zone is present', async () => {
    const { events } = await capture([{
        id: 'allday-zone',
        status: 'confirmed',
        updated: '2024-01-02T12:00:00Z',
        start: { date: '2024-03-15', timeZone: 'Europe/Zurich' },
        end: { date: '2024-03-18', timeZone: 'Europe/Zurich' },
    }]);
    const event = events[0]!;
    const schedule = scheduleOf(event);
    expect(event.occurred_at).toBe('2024-01-02T12:00:00Z');
    expect(event.occurred_at).not.toBe('2024-03-15T00:00:00Z');
    expect(schedule.start).toEqual({ date: '2024-03-15', timeZone: 'Europe/Zurich' });
    expect(schedule.end).toEqual({ date: '2024-03-18', timeZone: 'Europe/Zurich' });
    expect(schedule.start).not.toHaveProperty('dateTime');
    expect(schedule.end).not.toHaveProperty('dateTime');
    expect(schedule.end_semantics).toBe('exclusive');
});

test('a recurring series stays one unexpanded record and is not identified by iCalUID', async () => {
    const recurrence = ['RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=America/New_York:20240208T090000'];
    const ical = 'series-shared@google.com';
    const { fixture, batch, events } = await capture([{
        id: 'series1',
        status: 'confirmed',
        updated: '2024-01-02T12:00:00Z',
        iCalUID: ical,
        start: { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' },
        end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
        recurrence,
    }]);
    const event = events[0]!;
    const schedule = scheduleOf(event);
    expect(events).toHaveLength(1);
    expect(event.metadata.recurrence_expanded).toBe(false);
    expect(schedule.recurrence).toEqual(recurrence);
    expect(schedule.recurring_event_id).toBeNull();
    expect(event.source_record_id).not.toBe(ical);
    expect(event.source_record_id).not.toBe('series1');
    expect(batch.detail).toContain('recurrence_not_expanded');
    const listed = fixture.calls.map(url => new URL(url)).find(url => url.pathname.endsWith('/events'));
    expect(listed?.searchParams.get('singleEvents')).toBe('false');
    expect(listed?.searchParams.get('showDeleted')).toBe('true');
});

test('a moved exception keeps its instance identity and original start', async () => {
    const originalStart = { dateTime: '2024-02-15T09:00:00-05:00', timeZone: 'America/New_York' };
    const movedStart = { dateTime: '2024-02-15T11:00:00-05:00', timeZone: 'America/New_York' };
    const ical = 'series-shared@google.com';
    const { events } = await capture([
        {
            id: 'series1',
            status: 'confirmed',
            updated: '2024-01-02T12:00:00Z',
            iCalUID: ical,
            start: { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' },
            end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
            recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
        },
        {
            id: 'series1_20240215T140000Z',
            status: 'confirmed',
            updated: '2024-01-05T00:00:00Z',
            iCalUID: ical,
            recurringEventId: 'series1',
            originalStartTime: originalStart,
            start: movedStart,
            end: { dateTime: '2024-02-15T12:00:00-05:00', timeZone: 'America/New_York' },
        },
    ]);
    const eventsById = byEventId(events);
    const series = eventsById.get('series1')!;
    const instance = eventsById.get('series1_20240215T140000Z')!;
    expect(instance.source_record_id).not.toBe(series.source_record_id);
    expect(instance.source_record_id).not.toBe(ical);
    expect(series.source_record_id).not.toBe(ical);
    expect(scheduleOf(instance).recurring_event_id).toBe('series1');
    expect(scheduleOf(instance).original_start).toEqual(originalStart);
    expect(scheduleOf(instance).start).toEqual(movedStart);
    expect(scheduleOf(series).original_start).toBeNull();
    expect(instance.occurred_at).toBe('2024-01-05T00:00:00Z');
    expect(instance.occurred_at).not.toBe(movedStart.dateTime);
});

test('a cancelled exception tombs that instance without deleting the live series', async () => {
    const originalStart = { dateTime: '2024-02-08T09:00:00-05:00', timeZone: 'America/New_York' };
    const { events } = await capture([
        {
            id: 'series1',
            status: 'confirmed',
            updated: '2024-01-02T12:00:00Z',
            start: { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' },
            end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
            recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
            summary: 'Weekly series',
        },
        {
            id: 'series1_20240208T140000Z',
            status: 'cancelled',
            recurringEventId: 'series1',
            originalStartTime: originalStart,
            summary: 'Dropped instance text',
            attendees: [{ email: 'ada@example.test', displayName: 'Ada', responseStatus: 'accepted' }],
        },
    ]);
    const eventsById = byEventId(events);
    const series = eventsById.get('series1')!;
    const cancelled = eventsById.get('series1_20240208T140000Z')!;
    expect(series.deleted).toBe(false);
    expect(cancelled.deleted).toBe(true);
    expect(cancelled.source_record_id).not.toBe(series.source_record_id);
    expect(scheduleOf(cancelled).recurring_event_id).toBe('series1');
    expect(scheduleOf(cancelled).original_start).toEqual(originalStart);
    expect(cancelled.text).toBe('');
    expect(cancelled.metadata.attendees).toBeUndefined();
    expect(cancelled.subjects.every(subject => !subject.subject_id.startsWith('email:'))).toBe(true);
    expect(cancelled.occurred_at).toBe(cancelled.observed_at);
    expect(cancelled.metadata.provider_deleted_at).toBeNull();
    expect(cancelled.metadata.occurred_at_semantics).toBe('cancellation_first_observed');
});

test('a cancelled timed event without updated uses observation time, not the meeting start', async () => {
    const start = { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' };
    const { events } = await capture([{
        id: 'timed-cancel',
        status: 'cancelled',
        start,
        end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
    }]);
    const event = events[0]!;
    expect(event.deleted).toBe(true);
    expect(event.occurred_at).toBe(event.observed_at);
    expect(event.occurred_at).toBe('2024-01-03T00:00:00.000Z');
    expect(event.occurred_at).not.toBe(start.dateTime);
    expect(scheduleOf(event).start).toEqual(start);
    expect(event.metadata.occurred_at_semantics).toBe('cancellation_first_observed');
    expect(event.metadata.provider_deleted_at).toBeNull();
});

test('tentative is live schedule evidence, not a cancellation', async () => {
    const start = { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' };
    const { events } = await capture([{
        id: 'tentative1',
        status: 'tentative',
        updated: '2024-01-02T12:00:00Z',
        start,
        end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
        summary: 'Hold',
    }]);
    const event = events[0]!;
    expect(event.deleted).toBe(false);
    expect(event.metadata.status).toBe('tentative');
    expect(event.occurred_at).toBe('2024-01-02T12:00:00Z');
    expect(scheduleOf(event).start).toEqual(start);
    expect(event.text).toContain('Hold');
});

test('attendee responses are attendance, not the scheduled event or an inferred owner', async () => {
    const start = { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' };
    const { events } = await capture([{
        id: 'invite1',
        status: 'confirmed',
        updated: '2024-01-02T12:00:00Z',
        summary: 'Planning',
        start,
        end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
        organizer: { email: 'owner@example.test', displayName: 'Calendar Owner' },
        attendeesOmitted: true,
        attendees: [
            { email: 'ada@example.test', displayName: 'Ada', responseStatus: 'accepted' },
            { email: 'linus@example.test', responseStatus: 'declined' },
        ],
    }]);
    const event = events[0]!;
    const resource = event.subjects.filter(subject => subject.subject_id.startsWith('google-calendar-event:'));
    const emails = event.subjects.filter(subject => subject.subject_id.startsWith('email:'));
    expect(resource).toHaveLength(1);
    expect(resource[0]!.role).toBe('about');
    expect(resource[0]!.display_name).toBe('Google Calendar event');
    expect(emails).toEqual([
        { subject_id: 'email:ada@example.test', role: 'about', display_name: 'Ada' },
        { subject_id: 'email:linus@example.test', role: 'about' },
    ]);
    expect(event.subjects.some(subject => subject.subject_id === 'email:owner@example.test')).toBe(false);
    expect(event.metadata.attendees).toEqual([
        { email: 'ada@example.test', response_status: 'accepted' },
        { email: 'linus@example.test', response_status: 'declined' },
    ]);
    expect(event.metadata.attendees_omitted).toBe(true);
    expect(scheduleOf(event).start).toEqual(start);
    expect(event.occurred_at).toBe('2024-01-02T12:00:00Z');
});

test('unselected attendees never become subjects of the scheduled event', async () => {
    const fixture = new CalendarFixture();
    const selected = FIELDS.filter(field => field !== 'attendees');
    const state = parseState(fixture.state);
    state.fields = selected;
    fixture.state = encodeState(state);
    fixture.rows = [{
        id: 'invite-hidden',
        status: 'confirmed',
        updated: '2024-01-02T12:00:00Z',
        start: { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' },
        end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' },
        attendees: [{ email: 'ada@example.test', displayName: 'Ada', responseStatus: 'accepted' }],
    }];
    const connector = createGoogleCalendarConnector({
        client: { id: 'synthetic-client' },
        secret_ref: 'file:synthetic',
        calendar_id: fixture.calendar,
        fields: selected,
        expected_account: fixture.account,
    }, { now: fixture.now, fetch: fixture.fetch, persist: fixture.persist });
    await connector.connect(async () => new TextDecoder().decode(fixture.state));
    const batch = await connector.backfill(null);
    expect(batch.status).toBeUndefined();
    const event = batch.events[0]!;
    expect(validateEventInput(event).ok).toBe(true);
    expect(event.subjects.every(subject => !subject.subject_id.startsWith('email:'))).toBe(true);
    expect(event.metadata.attendees).toBeUndefined();
    expect(scheduleOf(event).start).toEqual({ dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' });
});
