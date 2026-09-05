/** Synthetic provider/state fixtures only; never operator enrollment. */
import type { StatePersister } from '@kizuki/core';
import { WhoopConnector, type WhoopDeps } from './connector';
import { encodeState, scopes, WHOOP_ID, type Selection, type Resource } from './state';
export class WhoopFixture {
    state: Uint8Array;
    readonly records: Record<Resource, Record<string, unknown>[]> = {
        cycle: [], recovery: [], sleep: [], workout: []
    };
    readonly requests: Request[] = [];
    account = 7;
    failStatus = 0;
    retry = '60';
    before: ((request: Request) => Promise<void>) | undefined;
    time = new Date('2026-02-01T00:00:00Z');
    readonly selection: Selection;
    constructor(count = 2, selected: Selection = {
        resources: ['cycle'], fields: ['metrics', 'activity'], history_start: '2026-01-01T00:00:00Z'
    }) {
        this.selection = selected;
        this.state = encodeState({
            schema: 'kizuki.whoop-state/v1', oauth: {
                schema: 'kizuki.oauth-state/v1', provider: WHOOP_ID, account: {
                    id: '7', display: 'Synthetic WHOOP account'
                }, tokens: {
                    access_token: 'synthetic-whoop-access', refresh_token: 'synthetic-whoop-refresh', expires_at: '2099-01-01T00:00:00Z', scope: scopes(selected).join(' '), token_type: 'Bearer'
                }, written_at: this.time.toISOString()
            }, selection: selected, pending: null, retry_at: null
        });
        for (const resource of selected.resources)
            for (let i = 1; i <= count; i++) {
                const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
                this.records[resource].push({
                    id: resource === 'cycle' ? i : uuid, cycle_id: i, sleep_id: uuid, user_id: 7, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', start: '2026-01-01T01:00:00Z', end: '2026-01-01T09:00:00Z', timezone_offset: '+00:00', nap: false, sport_id: 1, score_state: 'SCORED', score: resource === 'cycle' ? {
                        strain: i
                    } : resource === 'recovery' ? {
                        recovery_score: 0, user_calibrating: false
                    } : resource === 'sleep' ? {
                        respiratory_rate: null
                    } : {
                        strain: 0
                    }
                });
            }
    }
    now = () => new Date(this.time);
    persist: StatePersister = async (bytes) => {
        this.state = bytes.slice();
    };
    fetch = async (request: Request): Promise<Response> => {
        this.requests.push(request);
        await this.before?.(request);
        if (this.failStatus)
            return Response.json({
                private_provider_detail: 'never-emit'
            }, {
                status: this.failStatus, headers: {
                    'x-ratelimit-reset': this.retry
                }
            });
        const url = new URL(request.url);
        if (url.pathname.endsWith('user/profile/basic'))
            return Response.json({
                user_id: this.account, email: 'discard@example.test', first_name: 'Discard'
            });
        if (url.pathname.endsWith('user/access') && request.method === 'DELETE')
            return new Response(null, {
                status: 204
            });
        const resource = url.pathname.split('/').at(-1) as Resource;
        if (!Object.hasOwn(this.records, resource))
            throw Error('unexpected fixture route');
        const start = Number(url.searchParams.get('nextToken') ?? 0), records = this.records[resource];
        return Response.json({
            records: records.slice(start, start + 25), next_token: records.length > start + 25 ? String(start + 25) : null
        });
    };
    async connected(overrides: Partial<WhoopDeps> = {}) {
        const port = new WhoopConnector({
            secret_ref: 'file:/synthetic-protected-state', client: {
                id: 'synthetic-client', secret: 'synthetic-app-secret'
            }, selection: this.selection
        }, {
            persist: this.persist, fetch: this.fetch, now: this.now, ...overrides
        });
        await port.connect(async () => new TextDecoder().decode(this.state));
        return port;
    }
}
