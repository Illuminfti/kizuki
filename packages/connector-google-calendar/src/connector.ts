import { DeadlineError, HealthReport, KizukiError, OAuthSession, freezeManifest, loopbackTransport, parseOAuthState, signInWithBrowser, withDeadline, type Connector, type ConnectionStateWriter, type OAuthProvider, type OAuthTransport, type SecretResolver, type SignInIo, type StatePersister, type SyncBatch, } from "@kizuki/core";
import { Budget, CALENDAR_API, USERINFO, HttpFailure, getJson, type CalendarFetch } from "./api";
import { event, projection } from "./events";
import { ID, CURSOR, SCOPES, decodeCursor, digest, encodeCursor, encodeState, failure, fields, calendar, id, object, parseState, type Field, type State as GoogleCalendarState, type Cursor, type Plan } from "./state";
export interface GoogleCalendarConnectorConfig {
    secret_ref?: string;
    calendar_id?: string;
    /** Trusted application composition, never an owner key-pasting enrollment flow. */
    client?: {
        id: string;
        secret?: string;
    };
    /** Explicit persisted fields; absence refuses acquisition. */
    fields?: readonly Field[];
    /** Existing account identity supplied by the host for replacement enrollment. */
    expected_account?: string;
}
export interface GoogleCalendarConnectorDeps {
    persist?: StatePersister;
    /** Trusted host snapshot for reauthorization; never serialized configuration. */
    previousState?: Uint8Array;
    oauth?: OAuthTransport;
    fetch?: CalendarFetch;
    now?: () => Date;
}
const MANIFEST = freezeManifest({ schema: "kizuki.connector/v1", connector_id: ID, version: "0.1.0", contract_minor: 1, implementation: "@kizuki/connector-google-calendar", allowed_egress: ["accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "www.googleapis.com"], cursor_schema: CURSOR, kinds: ["calendar_event"], capabilities: { backfill: true, sync: true, tombstones: true, purge: false, fixture: true }, required_secrets: [], emits_sensitivity_hint: true, default_sensitivity: "private", sensitivity_floor: "private", auth_modes: ["oauth", "sign_in"] });
class CapacityGap extends Error {
    constructor(readonly reason: "initial_scan_capacity" | "cancellation_anchor_capacity") { super(reason); }
}
class SnapshotGap extends Error {
}
export class GoogleCalendarConnector implements Connector {
    private state: GoogleCalendarState | null = null;
    private session: OAuthSession | null = null;
    private disabled = false;
    private busy = false;
    private reloadRequired = false;
    private generation = 0;
    private pendingWrites = 0;
    private pendingTokens = 0;
    private origin: {
        state: GoogleCalendarState;
        persist: StatePersister;
    } | null = null;
    private last: "ok" | "misconfigured" | "unauthenticated" | "degraded" | "rate_limited" = "misconfigured";
    private readonly now: () => Date;
    private readonly config: GoogleCalendarConnectorConfig;
    private readonly previousState: GoogleCalendarState | null;
    private readonly deps: GoogleCalendarConnectorDeps;
    constructor(config: GoogleCalendarConnectorConfig = {}, deps: GoogleCalendarConnectorDeps = {}) {
        this.config = { ...config, ...(config.client ? { client: { ...config.client } } : {}), ...(config.fields ? { fields: [...config.fields] } : {}) };
        this.deps = { ...deps };
        this.previousState = deps.previousState === undefined ? null : parseState(deps.previousState.slice());
        this.now = deps.now ?? (() => new Date());
    }
    manifest() { return MANIFEST; }
    async health() { return new HealthReport({ state: this.disabled ? "disabled" : this.last, checked_at: this.now().toISOString(), detail: this.disabled ? "Google Calendar local session stopped" : this.last === "ok" ? "Google Calendar bounded capture; attachment bodies unsupported" : "Google Calendar unavailable; check application configuration and explicit enrollment" }); }
    private provider(): OAuthProvider {
        const client = this.config.client;
        if (!client || typeof client.id !== "string" || client.id.length === 0 || client.id.length > 512 || /[\s\x00-\x1f]/.test(client.id))
            throw failure("misconfigured");
        return { name: ID, authorization_url: "https://accounts.google.com/o/oauth2/v2/auth", token_url: "https://oauth2.googleapis.com/token", client_id: client.id, ...(client.secret === undefined ? {} : { client_secret: client.secret }), scopes: [...SCOPES], extra_authorization_params: { access_type: "offline", prompt: "consent" } };
    }
    private selected(): Field[] { return fields(this.config.fields); }
    private live(): void {
        if (this.disabled)
            throw failure("unauthenticated");
    }
    private require(): GoogleCalendarState {
        this.live();
        if (this.reloadRequired || this.pendingTokens > 0)
            throw failure("unavailable");
        if (!this.state || !this.session)
            throw failure("unauthenticated");
        return this.state;
    }
    private assertGeneration(generation: number): void {
        this.live();
        if (generation !== this.generation)
            throw failure("unavailable");
    }
    private invalidate(generation: number): void {
        if (generation !== this.generation)
            return;
        this.generation++;
        this.reloadRequired = true;
        this.session?.forget();
        this.session = null;
        this.state = null;
        this.origin = null;
    }
    /** Bound the wait, but retain custody until an uncancellable host write settles. */
    private async writeState(bytes: Uint8Array, write: StatePersister, generation: number, timeoutMs: number): Promise<void> {
        this.assertGeneration(generation);
        this.pendingWrites++;
        const pending = Promise.resolve().then(() => {
            this.assertGeneration(generation);
            return write(bytes);
        }).finally(() => { this.pendingWrites--; });
        try {
            await withDeadline(pending, timeoutMs, "Google Calendar state persistence deadline");
            this.assertGeneration(generation);
        }
        catch (error) {
            this.invalidate(generation);
            throw failure(error instanceof DeadlineError ? "timeout" : "unavailable");
        }
    }
    private async persist(next: GoogleCalendarState, generation = this.generation, timeoutMs = 5000): Promise<void> {
        if (!this.deps.persist)
            throw failure("misconfigured");
        await this.writeState(encodeState(next), this.deps.persist, generation, timeoutMs);
        this.assertGeneration(generation);
        this.state = next;
        if (this.origin !== null)
            this.origin.state = next;
    }
    async connect(resolve: SecretResolver): Promise<void> {
        this.live();
        const provider = this.provider();
        const selected = this.selected();
        const selectedCalendar = calendar(this.config.calendar_id);
        if (this.pendingWrites > 0 || this.pendingTokens > 0)
            throw failure("unavailable");
        if (!this.config.secret_ref || !this.deps.persist || this.busy)
            throw failure("misconfigured");
        this.busy = true;
        this.session?.forget();
        const generation = ++this.generation;
        try {
            const raw = await resolve(this.config.secret_ref);
            this.live();
            const state = parseState(new TextEncoder().encode(raw));
            if (selectedCalendar !== state.calendar || digest(selected) !== digest(state.fields) || this.config.expected_account !== undefined && state.oauth.account.id !== this.config.expected_account)
                throw failure("unauthenticated");
            this.state = state;
            this.reloadRequired = false;
            const origin = { state, persist: this.deps.persist };
            this.origin = origin;
            this.session = new OAuthSession({ provider, state: state.oauth, transport: this.deps.oauth ?? loopbackTransport({ postTimeoutMs: 5000 }), now: this.now, persist: async (bytes) => {
                    // Core must persist a successful rotation even after forget().
                    // This original CAS handle never adopts a replacement connection.
                    const oauth = parseOAuthState(bytes, ID);
                    if (oauth.account.id !== origin.state.oauth.account.id)
                        throw failure("unauthenticated");
                    const next = { ...origin.state, oauth };
                    this.pendingWrites++;
                    const pending = Promise.resolve().then(() => origin.persist(encodeState(next))).then(() => {
                        origin.state = next;
                    }).finally(() => { this.pendingWrites--; });
                    try {
                        await withDeadline(pending, 5000, "Google Calendar rotation persistence deadline");
                        if (!this.disabled && generation === this.generation && !this.reloadRequired)
                            this.state = next;
                    }
                    catch (error) {
                        this.invalidate(generation);
                        throw failure(error instanceof DeadlineError ? "timeout" : "unavailable");
                    }
                } });
            const identity = await this.request(new URL(USERINFO), new Budget());
            if (id(identity.sub) !== state.oauth.account.id)
                throw failure("unauthenticated");
            this.last = "ok";
        }
        catch (error) {
            this.invalidate(generation);
            this.last = error instanceof KizukiError && error.code === "rate_limited" ? "rate_limited" : "unauthenticated";
            throw failure(error instanceof KizukiError ? error.code : "unauthenticated");
        }
        finally {
            this.busy = false;
        }
    }
    async signIn(io: SignInIo, writer: ConnectionStateWriter) {
        this.live();
        const provider = this.provider(), selected = this.selected(), selectedCalendar = calendar(this.config.calendar_id);
        if (this.busy || this.pendingWrites > 0 || this.pendingTokens > 0 || this.reloadRequired)
            throw failure("unavailable");
        this.busy = true;
        const generation = this.generation;
        const authorization = new Budget(120000);
        try {
            const tokens = await signInWithBrowser(provider, io, this.deps.oauth ?? loopbackTransport({ postTimeoutMs: 5000 }), { timeoutMs: authorization.remaining(), now: this.now });
            this.assertGeneration(generation);
            if (!SCOPES.every(scope => tokens.scope.split(/\s+/).includes(scope)))
                throw failure("unauthenticated");
            const identity = await getJson(new URL(USERINFO), tokens.access_token, authorization, this.deps.fetch);
            this.assertGeneration(generation);
            const account = id(identity.sub);
            if (this.config.expected_account !== undefined && account !== this.config.expected_account)
                throw failure("unauthenticated");
            const oauth = { schema: "kizuki.oauth-state/v1" as const, provider: ID, account: { id: account, display: "Google Calendar account" }, tokens, written_at: this.now().toISOString() };
            if (this.previousState !== null && (this.previousState.calendar !== selectedCalendar || this.previousState.oauth.account.id !== account || digest(this.previousState.fields) !== digest(selected)))
                throw failure("unauthenticated");
            const state: GoogleCalendarState = { schema: "kizuki.google-calendar-state/v1", oauth, calendar: selectedCalendar, fields: selected, pending: this.previousState?.pending ?? null, anchors: this.previousState?.anchors ?? {}, retry_not_before: this.previousState?.retry_not_before ?? null };
            await this.writeState(encodeState(state), bytes => writer.write(bytes), generation, Math.min(5000, authorization.remaining()));
            this.assertGeneration(generation);
            this.invalidate(generation);
            return { display: "Google Calendar account" };
        }
        catch (error) {
            throw failure(error instanceof KizukiError ? error.code : "unauthenticated");
        }
        finally {
            this.busy = false;
        }
    }
    private async tokenWait<T>(operation: () => Promise<T>, budget: Budget, generation: number): Promise<T> {
        this.pendingTokens++;
        // Track the whole exchange, including mandatory late rotated-token custody.
        // withDeadline attaches a rejection handler even after its outer wait ends.
        const pending = Promise.resolve().then(() => {
            this.assertGeneration(generation);
            return operation();
        }).finally(() => { this.pendingTokens--; });
        try {
            const result = await withDeadline(pending, Math.min(5000, budget.remaining()), "Google Calendar token deadline");
            this.assertGeneration(generation);
            return result;
        }
        catch (error) {
            this.invalidate(generation);
            throw failure(error instanceof DeadlineError || error instanceof KizukiError && error.code === "timeout" ? "timeout" : "unauthenticated");
        }
    }
    private async request(url: URL, budget: Budget): Promise<Record<string, unknown>> {
        const state = this.require();
        if (state.retry_not_before !== null && Date.parse(state.retry_not_before) > this.now().getTime())
            throw failure("rate_limited");
        const session = this.session!, generation = this.generation;
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.tokenWait(() => session.accessToken(), budget, generation);
            this.assertGeneration(generation);
            budget.remaining();
            try {
                const result = await getJson(url, token, budget, this.deps.fetch);
                this.assertGeneration(generation);
                return result;
            }
            catch (error) {
                if (error instanceof HttpFailure && error.status === 429) {
                    await this.persist({ ...this.require(), retry_not_before: new Date(this.now().getTime() + error.retrySeconds * 1000).toISOString() }, generation, Math.min(5000, budget.remaining()));
                    throw failure("rate_limited");
                }
                if (!(error instanceof HttpFailure) || error.status !== 401 || attempt !== 0)
                    throw error;
                await this.tokenWait(() => session.refresh(), budget, generation);
            }
        }
        throw failure("unauthenticated");
    }
    private url(path: string, params: Record<string, string> = {}): URL {
        const url = new URL(path, CALENDAR_API);
        for (const [key, value] of Object.entries(params))
            url.searchParams.set(key, value);
        return url;
    }
    private async capture(input: string | null): Promise<SyncBatch> {
        const state = this.require();
        if (this.busy)
            throw failure('unavailable');
        // Invalid caller cursors reject before any provider work or state mutation.
        const initial: Cursor = input === null ? { schema: CURSOR, account: state.oauth.account.id, calendar: state.calendar, sync: null, page: null, count: 0, gap: false } : decodeCursor(input, state.oauth.account.id, state.calendar);
        this.busy = true;
        const budget = new Budget();
        try {
            const old = state.pending;
            const replay = old !== null && old.input === digest(input) && !(old.fingerprints.length === 0 && encodeCursor(old.next) === input);
            if (old !== null && !replay && encodeCursor(old.next) !== input)
                throw new SnapshotGap();
            let request = replay ? old!.request : initial;
            const observed = replay ? old!.observed_at : this.now().toISOString();
            const seen = new Set<string>();
            for (;;) {
                if (request.sync === null && request.count >= 1000)
                    throw new CapacityGap('initial_scan_capacity');
                const key = encodeCursor(request);
                if (seen.has(key))
                    throw failure();
                seen.add(key);
                const params: Record<string, string> = { maxResults: '20', singleEvents: 'false', showDeleted: 'true', maxAttendees: '64', fields: projection(state.fields) };
                if (request.sync !== null)
                    params.syncToken = request.sync;
                if (request.page !== null)
                    params.pageToken = request.page;
                let response: Record<string, unknown>;
                try {
                    response = await this.request(this.url(`${encodeURIComponent(state.calendar)}/events`, params), budget);
                }
                catch (error) {
                    if (error instanceof HttpFailure && error.status === 410 && replay)
                        throw new SnapshotGap();
                    if (error instanceof HttpFailure && error.status === 410 && request.sync !== null && !replay) {
                        request = { ...request, sync: null, page: null, count: 0, gap: true };
                        continue;
                    }
                    throw error;
                }
                const rows = response.items ?? [];
                if (!Array.isArray(rows) || rows.length > 20)
                    throw failure();
                const next: Cursor = { ...request, page: response.nextPageToken === undefined ? null : id(response.nextPageToken), sync: response.nextPageToken === undefined ? id(response.nextSyncToken) : request.sync, count: request.sync === null ? request.count + rows.length : 0 };
                if (response.nextPageToken !== undefined && response.nextSyncToken !== undefined)
                    throw failure();
                // Parsing our emitted cursor applies the same provider token/size bounds.
                decodeCursor(encodeCursor(next), state.oauth.account.id, state.calendar);
                if (rows.length === 0 && next.page !== null) {
                    request = next;
                    continue;
                }
                const anchors = { ...this.require().anchors };
                const identifiers = new Set<string>();
                const events = rows.map(value => {
                    const raw = object(value), eventId = id(raw.id);
                    if (identifiers.has(eventId))
                        throw failure();
                    identifiers.add(eventId);
                    const anchorKey = digest([state.oauth.account.id, state.calendar, eventId]);
                    if (raw.status === 'cancelled') {
                        anchors[anchorKey] ??= observed;
                    }
                    else
                        delete anchors[anchorKey];
                    return event(state.oauth.account.id, state.calendar, raw, observed, state.fields, anchors[anchorKey] ?? observed);
                });
                if (Object.keys(anchors).length > 1000)
                    throw new CapacityGap('cancellation_anchor_capacity');
                const fingerprints = events.map(digest);
                if (replay && (digest(fingerprints) !== digest(old!.fingerprints) || encodeCursor(next) !== encodeCursor(old!.next)))
                    throw new SnapshotGap();
                if (!replay) {
                    const pending: Plan = { input: digest(input), request, next, observed_at: observed, fingerprints };
                    await this.persist({ ...this.require(), pending, anchors }, this.generation, Math.min(5000, budget.remaining()));
                }
                this.live();
                budget.remaining();
                this.last = next.gap ? 'degraded' : 'ok';
                return { events, cursor: encodeCursor(next), detail: next.gap ? 'bounded_capture; history_gap_absence_unreconciled' : 'bounded_capture; recurrence_not_expanded; attachment_bodies_unsupported' };
            }
        }
        catch (error) {
            this.last = error instanceof Error && 'code' in error && error.code === 'rate_limited' ? 'rate_limited' : 'degraded';
            return { events: [], cursor: input, status: 'unavailable', detail: error instanceof CapacityGap ? `Google Calendar ${error.reason}; checkpoint retained; bounded coverage requires operator review` : error instanceof SnapshotGap ? 'Google Calendar snapshot_gap_unresolved; restore the original observation before advancing' : error instanceof KizukiError ? failure(error.code).message : 'Google Calendar unavailable; check bounded source coverage' };
        }
        finally {
            this.busy = false;
        }
    }
    backfill(cursor: string | null) { return this.capture(cursor); }
    sync(cursor: string | null) { return this.capture(cursor); }
    async revoke() { this.generation++; this.disabled = true; this.session?.forget(); this.session = null; this.state = null; this.origin = null; }
    async purgeSource(_subject: string): Promise<never> { throw failure('not_supported'); }
    async fixture() { return [event('fixture-account', 'fixture-calendar', { id: 'fixture1', status: 'confirmed', updated: '2024-01-02T12:00:00Z', start: { date: '2024-02-01' }, end: { date: '2024-02-02' } }, '2024-01-03T00:00:00Z', [], '2024-01-03T00:00:00Z')]; }
}
export function createGoogleCalendarConnector(config: GoogleCalendarConnectorConfig = {}, deps: GoogleCalendarConnectorDeps = {}): GoogleCalendarConnector { return new GoogleCalendarConnector(config, deps); }
