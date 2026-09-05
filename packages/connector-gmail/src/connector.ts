import { HealthReport, KizukiError, OAuthSession, freezeManifest, loopbackTransport, parseOAuthState, signInWithBrowser, withDeadline, type Connector, type ConnectionStateWriter, type OAuthProvider, type OAuthTransport, type SecretResolver, type SignInIo, type StatePersister, type SyncBatch, } from "@kizuki/core";
import { Budget, GMAIL_API, USERINFO, HttpFailure, getJson, type GmailFetch } from "./api";
import { messageEvent, messageProjection, tombstoneEvent } from "./events";
import { GMAIL_CONNECTOR_ID, GMAIL_CURSOR_SCHEMA, GMAIL_SCOPES, decodeCursor, digest, encodeCursor, encodeState, failure, fields, historyId, id, object, pageToken, parseState, planIdentity, type Change, type Field, type GmailCursor, type GmailState, type Plan, } from "./state";
export interface GmailConnectorConfig {
    secret_ref?: string;
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
export interface GmailConnectorDeps {
    persist?: StatePersister;
    oauth?: OAuthTransport;
    fetch?: GmailFetch;
    now?: () => Date;
}
const MANIFEST = freezeManifest({ schema: "kizuki.connector/v1", connector_id: GMAIL_CONNECTOR_ID, version: "0.1.0", contract_minor: 1, implementation: "@kizuki/connector-gmail", allowed_egress: ["accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "gmail.googleapis.com"], cursor_schema: GMAIL_CURSOR_SCHEMA, kinds: ["email"], capabilities: { backfill: true, sync: true, tombstones: true, purge: false, fixture: true }, required_secrets: [], emits_sensitivity_hint: true, default_sensitivity: "private", sensitivity_floor: "private", auth_modes: ["oauth"] });
class SnapshotGap extends Error {
}
export class GmailConnector implements Connector {
    private state: GmailState | null = null;
    private session: OAuthSession | null = null;
    private disabled = false;
    private busy = false;
    private reloadRequired = false;
    private last: "ok" | "misconfigured" | "unauthenticated" | "degraded" | "rate_limited" = "misconfigured";
    private readonly now: () => Date;
    private readonly config: GmailConnectorConfig;
    private readonly deps: GmailConnectorDeps;
    constructor(config: GmailConnectorConfig = {}, deps: GmailConnectorDeps = {}) {
        this.config = { ...config, ...(config.client ? { client: { ...config.client } } : {}), ...(config.fields ? { fields: [...config.fields] } : {}) };
        this.deps = { ...deps };
        this.now = deps.now ?? (() => new Date());
    }
    manifest() { return MANIFEST; }
    async health() { return new HealthReport({ state: this.disabled ? "disabled" : this.last, checked_at: this.now().toISOString(), detail: this.disabled ? "Gmail local session stopped" : this.last === "ok" ? "Gmail bounded capture; attachment bodies unsupported" : "Gmail unavailable; check application configuration and explicit enrollment" }); }
    private provider(): OAuthProvider {
        const client = this.config.client;
        if (!client || typeof client.id !== "string" || client.id.length === 0 || client.id.length > 512 || /[\s\x00-\x1f]/.test(client.id))
            throw failure("misconfigured");
        return { name: GMAIL_CONNECTOR_ID, authorization_url: "https://accounts.google.com/o/oauth2/v2/auth", token_url: "https://oauth2.googleapis.com/token", client_id: client.id, ...(client.secret === undefined ? {} : { client_secret: client.secret }), scopes: [...GMAIL_SCOPES], extra_authorization_params: { access_type: "offline", prompt: "consent" } };
    }
    private selected(): Field[] { return fields(this.config.fields); }
    private live(): void {
        if (this.disabled)
            throw failure("unauthenticated");
    }
    private require(): GmailState {
        this.live();
        if (this.reloadRequired)
            throw failure("unavailable");
        if (!this.state || !this.session)
            throw failure("unauthenticated");
        return this.state;
    }
    private async persist(next: GmailState): Promise<void> {
        this.live();
        if (!this.deps.persist)
            throw failure("misconfigured");
        const bytes = encodeState(next);
        try {
            await this.deps.persist(bytes);
        }
        catch {
            // A failed response cannot tell us whether the native state write committed.
            // Reload through the trusted resolver before exposing any later snapshot.
            this.reloadRequired = true;
            this.session?.forget();
            this.session = null;
            this.state = null;
            throw failure("unavailable");
        }
        this.live();
        this.state = next;
    }
    async connect(resolve: SecretResolver): Promise<void> {
        this.live();
        const provider = this.provider();
        const selected = this.selected();
        if (!this.config.secret_ref || !this.deps.persist || this.busy)
            throw failure("misconfigured");
        this.busy = true;
        try {
            const raw = await resolve(this.config.secret_ref);
            this.live();
            const state = parseState(new TextEncoder().encode(raw));
            if (digest(selected) !== digest(state.fields) || this.config.expected_account !== undefined && state.oauth.account.id !== this.config.expected_account)
                throw failure("unauthenticated");
            this.state = state;
            this.reloadRequired = false;
            this.session = new OAuthSession({ provider, state: state.oauth, transport: this.deps.oauth ?? loopbackTransport({ postTimeoutMs: 5000 }), now: this.now, persist: async (bytes) => {
                    const current = this.require();
                    await this.persist({ ...current, oauth: parseOAuthState(bytes, GMAIL_CONNECTOR_ID) });
                } });
            const identity = await this.request(new URL(USERINFO), new Budget());
            if (id(identity.sub) !== state.oauth.account.id)
                throw failure("unauthenticated");
            this.last = "ok";
        }
        catch (error) {
            this.session?.forget();
            this.session = null;
            this.state = null;
            this.last = "unauthenticated";
            throw failure(error instanceof KizukiError ? error.code : "unauthenticated");
        }
        finally {
            this.busy = false;
        }
    }
    async signIn(io: SignInIo, writer: ConnectionStateWriter) {
        this.live();
        const provider = this.provider(), selected = this.selected();
        if (this.busy)
            throw failure("unavailable");
        this.busy = true;
        try {
            const tokens = await signInWithBrowser(provider, io, this.deps.oauth ?? loopbackTransport({ postTimeoutMs: 5000 }), { timeoutMs: 120000, now: this.now });
            this.live();
            if (!GMAIL_SCOPES.every(scope => tokens.scope.split(/\s+/).includes(scope)))
                throw failure("unauthenticated");
            const identity = await getJson(new URL(USERINFO), tokens.access_token, new Budget(), this.deps.fetch);
            this.live();
            const account = id(identity.sub);
            if (this.config.expected_account !== undefined && account !== this.config.expected_account)
                throw failure("unauthenticated");
            const oauth = { schema: "kizuki.oauth-state/v1" as const, provider: GMAIL_CONNECTOR_ID, account: { id: account, display: "Gmail account" }, tokens, written_at: this.now().toISOString() };
            const state: GmailState = { schema: "kizuki.gmail-state/v1", oauth, fields: selected, pending: null };
            await writer.write(encodeState(state));
            this.live();
            return { display: "Gmail account" };
        }
        catch (error) {
            throw failure(error instanceof KizukiError ? error.code : "unauthenticated");
        }
        finally {
            this.busy = false;
        }
    }
    private async tokenWait<T>(pending: Promise<T>, budget: Budget): Promise<T> {
        try {
            return await withDeadline(pending, Math.min(5000, budget.remaining()), "Gmail token deadline");
        }
        catch {
            this.session?.forget();
            throw failure("unauthenticated");
        }
    }
    private async request(url: URL, budget: Budget): Promise<Record<string, unknown>> {
        this.require();
        const session = this.session!;
        let token = await this.tokenWait(session.accessToken(), budget);
        this.live();
        budget.remaining();
        try {
            const result = await getJson(url, token, budget, this.deps.fetch);
            this.live();
            return result;
        }
        catch (error) {
            if (!(error instanceof HttpFailure) || error.status !== 401)
                throw error;
            await this.tokenWait(session.refresh(), budget);
            this.live();
            budget.remaining();
            token = await this.tokenWait(session.accessToken(), budget);
            const result = await getJson(url, token, budget, this.deps.fetch);
            this.live();
            return result;
        }
    }
    private url(path: string, params: Record<string, string> = {}): URL {
        const url = new URL(path, GMAIL_API);
        for (const [key, value] of Object.entries(params))
            url.searchParams.set(key, value);
        return url;
    }
    private async initial(budget: Budget, gap = false): Promise<GmailCursor> {
        const profile = await this.request(this.url("profile", { fields: "historyId" }), budget);
        return { schema: GMAIL_CURSOR_SCHEMA, account: this.require().oauth.account.id, phase: "backfill", anchor: historyId(profile.historyId), page: null, count: 0, gap, capped: false, unresolved: false, plan: null, offset: 0 };
    }
    private async plan(input: string | null, base: GmailCursor, budget: Budget): Promise<Plan> {
        const observed_at = this.now().toISOString();
        let next: GmailCursor;
        let items: Change[] = [];
        if (base.phase === "backfill") {
            const response = await this.request(this.url("messages", { maxResults: "20", includeSpamTrash: "true", fields: "messages(id),nextPageToken", ...(base.page ? { pageToken: base.page } : {}) }), budget);
            const messages = response.messages ?? [];
            if (!Array.isArray(messages) || messages.length > 20)
                throw failure();
            items = messages.map(raw => ({ id: id(object(raw).id), deleted: false, history: base.anchor }));
            const page = pageToken(response.nextPageToken), count = base.count + items.length;
            if (count > 1000 || new Set(items.map(item => item.id)).size !== items.length)
                throw failure();
            const capped = base.capped || count === 1000 && page !== null;
            next = { ...base, phase: page !== null && !capped ? "backfill" : "sync", page: capped ? null : page, count, capped };
        }
        else {
            let response: Record<string, unknown>;
            try {
                response = await this.request(this.url("history", { startHistoryId: base.anchor, maxResults: "20", fields: "history(id,messagesAdded(message(id)),messagesDeleted(message(id)),labelsAdded(message(id)),labelsRemoved(message(id))),nextPageToken,historyId", ...(base.page ? { pageToken: base.page } : {}) }), budget);
            }
            catch (error) {
                if (error instanceof HttpFailure && error.status === 404)
                    return this.plan(input, await this.initial(budget, true), budget);
                throw error;
            }
            const records = response.history ?? [];
            if (!Array.isArray(records) || records.length > 20)
                throw failure();
            const changes = new Map<string, Change>();
            let total = 0;
            for (const raw of records) {
                const record = object(raw), history = historyId(record.id);
                if (BigInt(history) <= BigInt(base.anchor))
                    throw failure();
                for (const kind of ["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"]) {
                    const entries = record[kind] ?? [];
                    if (!Array.isArray(entries) || entries.length > 1000 || (total += entries.length) > 1000)
                        throw failure("unavailable");
                    for (const entry of entries) {
                        const message = id(object(object(entry).message).id), prior = changes.get(message);
                        changes.set(message, prior?.deleted ? prior : { id: message, deleted: kind === "messagesDeleted", history });
                    }
                }
            }
            items = [...changes.values()];
            const page = pageToken(response.nextPageToken), anchor = historyId(response.historyId);
            if (BigInt(anchor) < BigInt(base.anchor))
                throw failure();
            next = { ...base, page, anchor: page === null ? anchor : base.anchor };
        }
        const plan: Plan = { input: digest(input), base, next, observed_at, items, fence: null };
        await this.persist({ ...this.require(), pending: plan });
        return plan;
    }
    private async capture(input: string | null): Promise<SyncBatch> {
        // Contract errors are typed refusals, distinct from transient provider unavailability.
        const initialState = this.require();
        if (input !== null)
            decodeCursor(input, initialState.oauth.account.id);
        if (this.busy)
            return { events: [], cursor: input, status: "unavailable", detail: "Gmail operation already active" };
        this.busy = true;
        try {
            const state = this.require(), budget = new Budget();
            const cursor = input === null ? null : decodeCursor(input, state.oauth.account.id);
            let plan = state.pending, offset = 0;
            if (cursor?.plan !== null && cursor?.plan !== undefined) {
                if (!plan || planIdentity(plan) !== cursor.plan || digest({ ...cursor, unresolved: plan.base.unresolved, plan: null, offset: 0 }) !== digest(plan.base) || cursor.offset > plan.items.length)
                    throw failure();
                offset = cursor.offset;
            }
            else if (!plan || plan.input !== digest(input) || plan.items.length === 0 && encodeCursor(plan.next) === input) {
                plan = await this.plan(input, cursor ?? await this.initial(budget), budget);
            }
            const previous = plan.fence;
            if (previous !== null && offset !== previous.offset && offset !== previous.offset + previous.fingerprints.length ||
                previous === null && offset !== 0)
                throw new SnapshotGap();
            const events = [];
            const fingerprints: string[] = [];
            let missing = false;
            for (const change of plan.items.slice(offset, offset + 20)) {
                if (change.deleted) {
                    const event = tombstoneEvent(state.oauth.account.id, change, plan.observed_at);
                    events.push(event);
                    fingerprints.push(digest(event));
                }
                else {
                    try {
                        const url = this.url(`messages/${encodeURIComponent(change.id)}`, { format: state.fields.includes("text") || state.fields.includes("attachments") ? "full" : "metadata", fields: messageProjection(state.fields) });
                        if (!state.fields.includes("text"))
                            for (const header of ["From", "To", "Cc", "Subject", "Date", "Content-Type"])
                                url.searchParams.append("metadataHeaders", header);
                        const raw = await this.request(url, budget);
                        if (raw.id !== change.id)
                            throw failure();
                        const event = messageEvent(state.oauth.account.id, raw, plan.observed_at, state.fields);
                        events.push(event);
                        fingerprints.push(digest(event));
                    }
                    catch (error) {
                        if (error instanceof HttpFailure && error.status === 404) {
                            missing = true;
                            fingerprints.push(digest(["gmail.message_missing/v1", change]));
                        }
                        else
                            throw error;
                    }
                }
            }
            if (previous !== null && previous.offset === offset) {
                if (digest(previous.fingerprints) !== digest(fingerprints))
                    throw new SnapshotGap();
            }
            else if (fingerprints.length > 0) {
                plan = { ...plan, fence: { offset, fingerprints } };
                await this.persist({ ...this.require(), pending: plan });
            }
            this.live();
            budget.remaining();
            const consumed = Math.min(offset + 20, plan.items.length);
            const next = consumed < plan.items.length ? { ...plan.base, unresolved: plan.base.unresolved || cursor?.unresolved === true || missing, plan: planIdentity(plan), offset: consumed } : { ...plan.next, unresolved: plan.next.unresolved || cursor?.unresolved === true || missing };
            const detail = ["bounded_capture", ...(next.gap ? ["history_gap_deletions_unreconciled"] : []), ...(next.capped ? ["backfill_cap_partial"] : []), ...(next.unresolved ? ["message_unavailable_no_deletion_inferred"] : [])].join("; ");
            this.last = next.gap || next.capped || next.unresolved ? "degraded" : "ok";
            return { events, cursor: encodeCursor(next), detail };
        }
        catch (error) {
            this.last = error instanceof KizukiError && error.code === "rate_limited" ? "rate_limited" : "degraded";
            return { events: [], cursor: input, status: "unavailable", detail: error instanceof SnapshotGap ? "Gmail snapshot_gap_unresolved; provider observation changed or checkpoint is stale; no history was advanced" : error instanceof KizukiError ? failure(error.code).message : "Gmail unavailable; check permissions or source coverage" };
        }
        finally {
            this.busy = false;
        }
    }
    backfill(cursor: string | null) { return this.capture(cursor); }
    sync(cursor: string | null) { return this.capture(cursor); }
    async revoke() { this.disabled = true; this.session?.forget(); this.session = null; this.state = null; }
    async purgeSource(_subject: string): Promise<never> { throw failure("not_supported"); }
    async fixture() { return [messageEvent("fixture-account", { id: "fixture-message", threadId: "fixture-thread", historyId: "100", internalDate: "1704067200000", payload: { mimeType: "text/plain", body: { data: Buffer.from("Synthetic Gmail fixture").toString("base64url") } } }, "2024-01-01T00:00:00.000Z", ["text"])]; }
}
export function createGmailConnector(config: GmailConnectorConfig = {}, deps: GmailConnectorDeps = {}): GmailConnector { return new GmailConnector(config, deps); }
