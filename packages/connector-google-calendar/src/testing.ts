/** Synthetic-only provider transport; no browser, account or network. */
import { KizukiError, type StatePersister } from '@kizuki/core';
import { createGoogleCalendarConnector } from './connector';
import { ID, SCOPES, FIELDS, encodeState } from './state';
export class CalendarFixture {
    state: Uint8Array;
    account = 'fixture-account';
    calendar = 'fixture-calendar';
    calls: string[] = [];
    rows: Record<string, unknown>[];
    expired = false;
    version = 1;
    failStatus = 0;
    private time = new Date('2024-01-03T00:00:00Z');
    constructor() { this.rows = [{ id: 'allday1', status: 'confirmed', etag: '"v1"', updated: '2024-01-02T12:00:00Z', summary: 'Synthetic all-day', start: { date: '2024-02-01' }, end: { date: '2024-02-02' } }, { id: 'recurring1', status: 'confirmed', etag: '"v1"', updated: '2024-01-02T12:00:00Z', summary: 'Synthetic recurrence', start: { dateTime: '2024-02-01T09:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2024-02-01T10:00:00-05:00', timeZone: 'America/New_York' }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] }]; this.state = encodeState({ schema: 'kizuki.google-calendar-state/v1', oauth: { schema: 'kizuki.oauth-state/v1', provider: ID, account: { id: this.account, display: 'Synthetic account' }, tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: '2099-01-01T00:00:00Z', scope: SCOPES.join(' '), token_type: 'Bearer' }, written_at: this.time.toISOString() }, calendar: this.calendar, fields: [...FIELDS], pending: null, anchors: {}, retry_not_before: null }); }
    now = () => new Date(this.time);
    advance() { this.time = new Date(this.time.getTime() + 86400000); }
    persist: StatePersister = async (bytes) => { this.state = bytes.slice(); };
    fetch = async (request: Request): Promise<Response> => {
        this.calls.push(request.url);
        if (this.failStatus)
            return Response.json({ error: { errors: [{ reason: 'rateLimitExceeded', message: 'PRIVATE_PROVIDER_SECRET' }] } }, { status: this.failStatus, headers: { 'Retry-After': '60' } });
        const url = new URL(request.url);
        if (url.hostname === 'openidconnect.googleapis.com')
            return Response.json({ sub: this.account });
        if (url.pathname !== `/calendar/v3/calendars/${this.calendar}/events`)
            throw Error('unexpected synthetic request');
        if (this.expired && url.searchParams.has('syncToken')) {
            this.expired = false;
            return Response.json({}, { status: 410 });
        }
        const offset = Number(url.searchParams.get('pageToken') ?? 0), rows = url.searchParams.get('syncToken') === `s${this.version}` ? [] : this.rows;
        return Response.json({ items: rows.slice(offset, offset + 20), ...(rows.length > offset + 20 ? { nextPageToken: String(offset + 20) } : { nextSyncToken: `s${this.version}` }) });
    };
    async connected(persist: StatePersister = this.persist) { const c = createGoogleCalendarConnector({ client: { id: 'synthetic-client' }, secret_ref: 'file:synthetic', calendar_id: this.calendar, fields: FIELDS, expected_account: this.account }, { now: this.now, fetch: this.fetch, persist, oauth: { listen: async () => { throw new KizukiError('timeout', 'Synthetic cancellation'); }, postForm: async () => { throw new KizukiError('unauthenticated', 'Synthetic refresh refused'); } } }); await c.connect(async () => new TextDecoder().decode(this.state)); return c; }
}
