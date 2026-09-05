import { DeadlineError, HealthReport, OAuthSession, freezeManifest, loopbackTransport, parseOAuthState, withDeadline, type CaptureEventInput, type Connector, type OAuthProvider, type OAuthTransport, type SecretResolver, type StatePersister, type SyncBatch } from '@kizuki/core';
import { Budget, HttpFailure, ORIGIN, request, type WhoopFetch } from './api';
import { recordEvent } from './events';
import { WHOOP_ID, CURSOR_SCHEMA, compareInstants, decodeCursor, digest, encodeCursor, encodeState, failure, integerId, parseState, planId, scopes, selection, type Selection, type Plan, type WhoopState } from './state';
export interface WhoopConfig {
    secret_ref: string;
    client: {
        id: string;
        secret: string;
    };
    selection: Selection;
    expected_account?: string;
}
export interface WhoopDeps {
    persist: StatePersister;
    fetch?: WhoopFetch;
    oauth?: OAuthTransport;
    now?: () => Date;
}
const MANIFEST = freezeManifest({
    schema: 'kizuki.connector/v1', connector_id: WHOOP_ID, version: '0.1.0', contract_minor: 1, implementation: '@kizuki/connector-whoop', allowed_egress: ['api.prod.whoop.com'], cursor_schema: CURSOR_SCHEMA, kinds: ['health'], capabilities: {
        backfill: true, sync: true, tombstones: false, purge: false, fixture: true
    }, required_secrets: [], emits_sensitivity_hint: true, default_sensitivity: 'private', sensitivity_floor: 'private', auth_modes: ['secret_ref']
});
const ROUTE = {
    cycle: 'cycle', recovery: 'recovery', sleep: 'activity/sleep', workout: 'activity/workout'
} as const;
export class WhoopConnector implements Connector {
    private state: WhoopState | null = null;
    private session: OAuthSession | null = null;
    private generation = 0;
    private writes = 0;
    private pendingTokens = 0;
    private origin: { state: WhoopState; persist: StatePersister } | null = null;
    private operationBudget: Budget | null = null;
    private busy = false;
    private disabled = false;
    private reload = false;
    private status: 'misconfigured' | 'unauthenticated' | 'degraded' | 'rate_limited' = 'misconfigured';
    private readonly config: WhoopConfig;
    private readonly deps: WhoopDeps;
    private readonly now: () => Date;
    constructor(config: WhoopConfig, deps: WhoopDeps) {
        // The manifest is callable before connect. Never retain a malformed
        // reference that could publish pasted credentials as required secrets.
        if (typeof config.secret_ref !== 'string' || Buffer.byteLength(config.secret_ref) > 4096 ||
            !/^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\x00-\x1f\x7f]+)$/.test(config.secret_ref))
            throw failure('misconfigured');
        this.config = {
            ...config, client: {
                ...config.client
            }, selection: selection(config.selection)
        };
        this.deps = {
            ...deps
        };
        this.now = deps.now ?? (() => new Date());
    }
    manifest() {
        return freezeManifest({ ...MANIFEST, required_secrets: [this.config.secret_ref] });
    }
    async health() {
        return new HealthReport({
            state: this.disabled ? 'disabled' : this.state?.retry_at && compareInstants(this.state.retry_at, this.now().toISOString()) > 0 ? 'rate_limited' : this.status, checked_at: this.now().toISOString(), detail: 'WHOOP bounded history rescan; polling cannot confirm deletions; native enrollment unqualified'
        });
    }
    private provider(): OAuthProvider {
        const c = this.config.client;
        if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 512 || typeof c.secret !== 'string' || !c.secret || c.secret.length > 4096)
            throw failure('misconfigured');
        return {
            name: WHOOP_ID, authorization_url: ORIGIN + '/oauth/oauth2/auth', token_url: ORIGIN + '/oauth/oauth2/token', client_id: c.id, client_secret: c.secret, scopes: scopes(this.config.selection)
        };
    }
    private live(g = this.generation) {
        if (this.disabled || g !== this.generation || this.reload)
            throw failure('unavailable');
    }
    private require(): WhoopState {
        this.live();
        if (!this.state || !this.session)
            throw failure('unauthenticated');
        return this.state;
    }
    private invalidate(g: number) {
        if (g !== this.generation)
            return;
        this.generation++;
        this.reload = true;
        this.status = 'unauthenticated';
        this.session?.forget();
        this.session = null;
        this.state = null;
        this.origin = null;
    }
    private async persist(next: WhoopState, g = this.generation, ms = 5000) {
        this.live(g);
        const bytes = encodeState(next);
        const origin = this.origin;
        this.writes++;
        const write = Promise.resolve().then(() => {
            this.live(g);
            return this.deps.persist(bytes).then(() => {
                if (origin) origin.state = next;
            });
        }).finally(() => {
            this.writes--;
        });
        try {
            await withDeadline(write, ms, 'WHOOP persistence timeout');
            this.live(g);
            this.state = next;
        }
        catch (error) {
            this.invalidate(g);
            throw failure(error instanceof DeadlineError ? 'timeout' : 'unavailable');
        }
    }
    async connect(resolve: SecretResolver): Promise<void> {
        if (this.disabled || this.busy || this.writes > 0 || this.pendingTokens > 0)
            throw failure('unavailable');
        const provider = this.provider();
        const g = ++this.generation;
        this.session?.forget();
        this.state = null;
        this.origin = null;
        this.session = null;
        this.reload = false;
        try {
            const bytes = await withDeadline(resolve(this.config.secret_ref), 5000, 'WHOOP state read timeout');
            this.live(g);
            const state = parseState(new TextEncoder().encode(bytes));
            if (digest(state.selection) !== digest(this.config.selection) || this.config.expected_account !== undefined && state.oauth.account.id !== this.config.expected_account)
                throw failure('identity_mismatch');
            this.state = state;
            const origin = { state, persist: this.deps.persist };
            this.origin = origin;
            const account = state.oauth.account.id;
            const transport = this.deps.oauth ?? loopbackTransport();
            this.session = new OAuthSession({
                provider, state: state.oauth, transport: {
                    listen: path => transport.listen(path),
                    postForm: async (url, form) => {
                        this.live(g);
                        if (this.operationBudget === null)
                            throw failure('unavailable');
                        this.operationBudget.requestMs();
                        // accessToken() owns the one remaining-aware timeout. A second
                        // competing timer here would obscure an interrupted exchange.
                        return transport.postForm(url, form);
                    },
                }, now: this.now, persist: async (bytes) => {
                    // Core must persist a successful rotation even after forget().
                    // Only the original host CAS handle owns this exchange; never
                    // resolve/retry against a replacement connection.
                    const oauth = parseOAuthState(bytes, WHOOP_ID);
                    if (origin.state.oauth.account.id !== account || oauth.account.id !== account)
                        throw failure('identity_mismatch');
                    const next = { ...origin.state, oauth };
                    this.writes++;
                    try {
                        await origin.persist(encodeState(next));
                        origin.state = next;
                        if (g === this.generation && !this.disabled && !this.reload)
                            this.state = next;
                    } finally {
                        this.writes--;
                    }
                }
            });
            this.status = 'degraded';
        }
        catch (error) {
            if (g === this.generation) {
                this.invalidate(g);
                this.status = 'unauthenticated';
            }
            throw failure(error instanceof DeadlineError ? 'timeout' : 'unauthenticated');
        }
    }
    private async token(budget: Budget): Promise<string> {
        const g = this.generation;
        // Refuse an expired method before starting uncancellable token custody.
        const timeoutMs = Math.min(5000, budget.remaining());
        if (budget.exhausted) throw failure('request_limit');
        const session = this.session!;
        try {
            this.pendingTokens++;
            const exchange = Promise.resolve().then(() => {
                this.live(g);
                return session.accessToken();
            }).finally(() => { this.pendingTokens--; });
            void exchange.catch(() => undefined);
            const token = await withDeadline(exchange, timeoutMs, 'WHOOP refresh timeout');
            this.live(g);
            return token;
        }
        catch (error) {
            this.invalidate(g);
            throw failure(budget.exceeded ? 'request_limit' : error instanceof DeadlineError ? 'timeout' : 'unauthenticated');
        }
    }
    private async call(path: string, budget: Budget, query?: URLSearchParams, method: 'GET' | 'DELETE' = 'GET') {
        const state = this.require();
        if (state.retry_at !== null && compareInstants(state.retry_at, this.now().toISOString()) > 0)
            throw failure('rate_limited');
        const url = new URL('/developer/v2/' + path, ORIGIN);
        if (query)
            url.search = query.toString();
        try {
            const result = await request(url, await this.token(budget), budget, this.deps.fetch, method);
            this.live();
            this.status = 'degraded';
            return result;
        }
        catch (error) {
            if (error instanceof HttpFailure && error.status === 429) {
                await this.persist({
                    ...this.require(), retry_at: new Date(this.now().getTime() + (error.retrySeconds ?? 60) * 1000).toISOString()
                }, this.generation, Math.min(5000, budget.remaining()));
                this.status = 'rate_limited';
                throw failure('rate_limited');
            }
            if (error instanceof HttpFailure)
                throw failure(error.status === 401 ? 'unauthenticated' : error.status === 404 ? 'coverage_gap' : 'provider_error');
            throw error;
        }
    }
    private async scan(end: string, observed: string, budget: Budget): Promise<CaptureEventInput[]> {
        const state = this.require(), account = state.oauth.account.id;
        const profile = await this.call('user/profile/basic', budget);
        if (integerId(profile.user_id) !== account)
            throw failure('identity_mismatch');
        const events: CaptureEventInput[] = [];
        const keys = new Set<string>();
        for (const resource of state.selection.resources) {
            let token: string | null = null;
            const seen = new Set<string>();
            do {
                const query = new URLSearchParams({
                    start: state.selection.history_start, end, limit: '25'
                });
                if (token !== null)
                    query.set('nextToken', token);
                const page = await this.call(ROUTE[resource], budget, query);
                if (!Array.isArray(page.records) || page.records.length > 25)
                    throw failure();
                for (const record of page.records) {
                    if (events.length >= 1000)
                        throw failure('history_limit');
                    const event = recordEvent(resource, record, account, state.selection.fields, observed);
                    if (keys.has(event.source_record_id))
                        throw failure('snapshot_gap_unresolved');
                    keys.add(event.source_record_id);
                    events.push(event);
                }
                const next = page.next_token;
                if (next === undefined || next === null || next === '')
                    token = null;
                else {
                    if (typeof next !== 'string' || next.length > 2048 || /[\x00-\x20\x7f]/.test(next) || seen.has(next))
                        throw failure('pagination_gap');
                    seen.add(next);
                    token = next;
                }
            } while (token !== null);
        }
        return events.sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);
    }
    backfill(cursor: string | null = null) {
        return this.run(cursor);
    }
    sync(cursor: string | null) {
        return this.run(cursor);
    }
    private async run(cursor: string | null): Promise<SyncBatch> {
        if (this.disabled)
            throw failure('unauthenticated');
        if (cursor !== null)
            decodeCursor(cursor);
        if (this.busy || this.pendingTokens > 0 || this.writes > 0)
            throw failure('unavailable');
        this.busy = true;
        try {
            const state = this.require();
            const budget = new Budget();
            this.operationBudget = budget;
            let offset = 0;
            let plan = state.pending;
            let completed: Plan | null = null;
            const c = cursor === null ? null : decodeCursor(cursor);
            if (c && (c.account !== state.oauth.account.id || c.selection !== digest(state.selection)))
                throw failure('invalid_cursor');
            if (plan && cursor === plan.base)
                offset = 0;
            else if (plan && c && c.plan === plan.id && c.offset <= plan.issued && (c.offset % 25 === 0 || c.offset === plan.entries.length)) {
                if (c.offset === plan.entries.length) {
                    completed = plan;
                    plan = null;
                    offset = 0;
                }
                else
                    offset = c.offset;
            }
            else if (cursor !== null || plan !== null)
                throw failure('invalid_cursor');
            const observed = plan?.observed ?? this.now().toISOString(), end = plan?.end ?? observed;
            if (compareInstants(end, state.selection.history_start) < 0)
                throw failure('misconfigured');
            const events = await this.scan(end, observed, budget);
            const entries = events.map(e => ({
                key: e.source_record_id, hash: digest({
                    ...e, observed_at: null
                })
            }));
            if (completed && digest(entries) === digest(completed.entries))
                return {
                    events: [], cursor, detail: 'bounded_rescan; non_atomic_listing; polling_deletions_unavailable'
                };
            if (plan !== null) {
                if (digest(entries) !== digest(plan.entries))
                    throw failure('snapshot_gap_unresolved');
            }
            else {
                const draft = {
                    base: cursor, end, observed, entries, issued: 0
                };
                plan = {
                    ...draft, id: planId(draft, state.oauth.account.id, state.selection)
                };
                await this.persist({
                    ...this.require(), pending: plan
                }, this.generation, Math.min(5000, budget.remaining()));
            }
            // Issued boundary is durable before yield. No content bodies enter auth state.
            {
                const next = Math.min(offset + 25, events.length);
                plan = {
                    ...plan, issued: Math.max(plan.issued, next)
                };
                await this.persist({
                    ...this.require(), pending: plan
                }, this.generation, Math.min(5000, budget.remaining()));
                const nextCursor = encodeCursor({
                    schema: CURSOR_SCHEMA, account: state.oauth.account.id, selection: digest(state.selection), plan: plan.id, offset: next
                });
                return {
                    events: events.slice(offset, next), cursor: nextCursor, detail: 'bounded_rescan; non_atomic_listing; polling_deletions_unavailable'
                };
            }
        }
        catch (error) {
            return {
                events: [], cursor, status: 'unavailable', detail: error instanceof Error && error.name === 'KizukiError' ? error.message : 'WHOOP unavailable; bounded capture refused'
            };
        }
        finally {
            this.operationBudget = null;
            this.busy = false;
        }
    }
    /** Explicit provider authorization revoke. This never deletes health data. */
    async revokeProviderAccess(): Promise<void> {
        if (this.disabled)
            throw failure('unauthenticated');
        if (this.busy || this.pendingTokens > 0 || this.writes > 0)
            throw failure('unavailable');
        this.require();
        this.busy = true;
        try {
            this.operationBudget = new Budget();
            await this.call('user/access', this.operationBudget, undefined, 'DELETE');
            await this.close();
        }
        finally {
            this.operationBudget = null;
            this.busy = false;
        }
    }
    /** Connector contract: idempotent local cessation, not provider revocation. */
    async revoke(): Promise<void> {
        await this.close();
    }
    /** Local terminal cleanup; no provider request or source-consent mutation. */
    async close(): Promise<void> {
        this.disabled = true;
        this.generation++;
        this.session?.forget();
        this.session = null;
        this.state = null;
        this.origin = null;
    }
    async purgeSource(_subject: string): Promise<never> {
        throw failure('not_supported');
    }
    async fixture() {
        return [recordEvent('cycle', {
                id: 1, user_id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', score_state: 'SCORED', score: {
                    strain: 0
                }
            }, '7', ['metrics'], '2026-01-03T00:00:00Z')];
    }
}
export function createWhoopConnector(config: WhoopConfig, deps: WhoopDeps) {
    return new WhoopConnector(config, deps);
}
