import { expect, test } from 'bun:test';
import { CalendarFixture } from '../src/testing';
import { createGoogleCalendarConnector } from '../src';
import { FIELDS, parseState, encodeState } from '../src/state';
import { Budget, getJson, MAX_RESPONSE_BYTES, USERINFO } from '../src/api';
for (const changed of ['updated', 'date', 'zone', 'status', 'id'] as const)
    test(`invalid provider ${changed} refuses without plan publication`, async () => {
        const f = new CalendarFixture();
        if (changed === 'updated')
            delete f.rows[0]!.updated;
        else if (changed === 'date')
            f.rows[0]!.start = { date: '2024-02-30' };
        else if (changed === 'zone')
            f.rows[0]!.start = { dateTime: '2024-02-01T09:00:00', timeZone: 'Not/A_Zone' };
        else if (changed === 'status')
            f.rows[0]!.status = 'unknown';
        else
            f.rows[0]!.id = 'invisible\u200b';
        const old = f.state.slice(), b = await (await f.connected()).backfill(null);
        expect(b.events).toEqual([]);
        expect(b.status).toBe('unavailable');
        expect(f.state).toEqual(old);
    });
for (const selected of ['primary', 'PRIMARY'])
    test(`ambiguous ${selected} alias refuses before transport`, async () => { const f = new CalendarFixture(); const c = createGoogleCalendarConnector({ client: { id: 'synthetic' }, calendar_id: selected, fields: FIELDS, secret_ref: 'file:synthetic' }, { fetch: f.fetch, persist: f.persist }); await expect(c.connect(async () => new TextDecoder().decode(f.state))).rejects.toMatchObject({ code: 'misconfigured' }); expect(f.calls).toEqual([]); });
test('account and calendar cursor confusion refuses before provider', async () => { const f = new CalendarFixture(), c = await f.connected(), b = await c.backfill(null); const wrong = JSON.parse(b.cursor!); wrong.calendar = 'another-calendar'; const calls = f.calls.length; await expect(c.sync(JSON.stringify(wrong))).rejects.toThrow(); expect(f.calls).toHaveLength(calls); });
test('empty intermediate pages are drained with a bounded GET count', async () => {
    const f = new CalendarFixture();
    let pages = 0;
    const c = createGoogleCalendarConnector({ client: { id: 'synthetic' }, calendar_id: f.calendar, fields: FIELDS, secret_ref: 'file:synthetic' }, { now: f.now, persist: f.persist, fetch: async (req) => new URL(req.url).hostname === 'openidconnect.googleapis.com' ? f.fetch(req) : (pages++, Response.json({ items: [], nextPageToken: `p${pages}` })) });
    await c.connect(async () => new TextDecoder().decode(f.state));
    const b = await c.backfill(null);
    expect(pages).toBe(25);
    expect(b.status).toBe('unavailable');
    expect(b.cursor).toBeNull();
    expect(parseState(f.state).pending).toBeNull();
});
test('attachment bodies and unknown sizes never become invented values', async () => { const f = new CalendarFixture(); f.rows[0]!.attachments = [{ fileId: 'synthetic-file', title: 'fixture', mimeType: 'text/plain', fileUrl: 'https://private.invalid/sentinel' }]; const b = await (await f.connected()).backfill(null); expect(b.events[0]!.attachments[0]!.byte_size).toBeUndefined(); expect(JSON.stringify(b.events)).not.toContain('private.invalid'); expect(b.events[0]!.metadata.attachment_bodies).toBe('unsupported'); });
test('unknown or excessive opaque state fails closed', () => { const f = new CalendarFixture(), s = parseState(f.state); const raw = JSON.parse(new TextDecoder().decode(f.state)); raw.unrecognized = 'sentinel'; expect(() => parseState(new TextEncoder().encode(JSON.stringify(raw)))).toThrow(); s.oauth.tokens.scope = 'openid'; expect(() => encodeState(s)).toThrow(); });
test('fixed GET boundary rejects foreign origin without transport', async () => { let calls = 0; await expect(getJson(new URL('https://evil.invalid/calendar'), 'synthetic', new Budget(), async () => { calls++; return Response.json({}); })).rejects.toThrow(); expect(calls).toBe(0); });
test('streamed oversized JSON refuses and never returns provider content', async () => { let cancelled = false; const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } }); await expect(getJson(new URL(USERINFO), 'synthetic', new Budget(), async (request) => { expect(request.method).toBe('GET'); expect(request.redirect).toBe('error'); return new Response(body); })).rejects.toThrow('Google Calendar'); expect(cancelled).toBe(true); });
