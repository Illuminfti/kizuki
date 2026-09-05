import { DeadlineError, HealthReport, OAuthSession, freezeManifest, isSecretRef, loopbackTransport, parseOAuthState, revokeToken, signInWithBrowser, withDeadline,
  type Connector, type ConnectionStateWriter, type HealthState, type OAuthProvider, type OAuthTransport, type SecretResolver, type SignInIo, type StatePersister, type SyncBatch } from "@kizuki/core";
import { ApiBudget, HttpFailure, X_API_ORIGIN, X_API_REQUEST_MS, fieldsQuery, request, type XApiFetch } from "./client";
import { parseAccount, parsePage, type XApiPage } from "./parse";
import { MAX_WALK_PAGES, X_API_CONNECTOR_ID, X_API_CURSOR_SCHEMA, X_API_SCOPES, X_API_STATE_SCHEMA, compareInstants, digest, encodeCursor, encodeState, failure, failureRule, id, normalizedFailure,
  parseCursor, parseState, planDigest, selection, type XApiCursor, type XApiPlan, type XApiSelection, type XApiState } from "./state";

export interface XApiConfig { client_id?: string; secret_ref?: string; selection?: XApiSelection; expected_account?: string }
export interface XApiDeps { persist?: StatePersister; fetch?: XApiFetch; oauth?: OAuthTransport; now?: () => Date; clock?: () => number }
const COVERAGE = "X own-post API window; history capped; provider deletion coverage and native enrollment unqualified";
function coverageDetail(cursor: string): string { return `${COVERAGE}; ${parseCursor(cursor).phase === "idle" ? "available window drained" : "continuation pending"}`; }
const MANIFEST = freezeManifest({ schema: "kizuki.connector/v1", connector_id: X_API_CONNECTOR_ID, version: "0.1.0", contract_minor: 1,
  implementation: "@kizuki/connector-x/api", allowed_egress: ["api.x.com", "x.com"], cursor_schema: X_API_CURSOR_SCHEMA, kinds: ["post"],
  capabilities: { backfill: true, sync: true, tombstones: false, purge: false, fixture: true }, required_secrets: [],
  emits_sensitivity_hint: true, default_sensitivity: "private", sensitivity_floor: "private", auth_modes: ["oauth", "secret_ref"] });
interface Custody { state: XApiState; persist: StatePersister }
interface TokenAdmission { budget: ApiBudget; refusal: ReturnType<typeof failure> | null; rateLimited: boolean }

export class XApiConnector implements Connector {
  private state: XApiState | null = null;
  private session: OAuthSession | null = null;
  private custody: Custody | null = null;
  private admission: TokenAdmission | null = null;
  private operationBudget: ApiBudget | null = null;
  private generation = 0;
  private busy = false;
  private disabled = false;
  private reloadRequired = false;
  private pendingWrites = 0;
  private pendingTokens = 0;
  private last: HealthState = "misconfigured";
  private lastSuccess: string | undefined;
  private readonly config: XApiConfig;
  private readonly deps: XApiDeps;
  private readonly transport: OAuthTransport;
  private readonly now: () => Date;
  constructor(config: XApiConfig = {}, deps: XApiDeps = {}) {
    if (config.secret_ref !== undefined && (!isSecretRef(config.secret_ref) || Buffer.byteLength(config.secret_ref) > 4096 || /[\x00-\x1f\x7f]/.test(config.secret_ref))) throw failure("misconfigured");
    this.config = { ...config, ...(config.selection === undefined ? {} : { selection: selection(config.selection) }) };
    if (config.expected_account !== undefined) { try { id(config.expected_account); } catch { throw failure("misconfigured"); } }
    this.deps = { ...deps }; this.now = deps.now ?? (() => new Date());
    this.transport = deps.oauth ?? loopbackTransport({ postTimeoutMs: X_API_REQUEST_MS });
  }
  manifest() { return freezeManifest({ ...MANIFEST, required_secrets: this.config.secret_ref === undefined ? [] : [this.config.secret_ref] }); }
  async health() {
    return new HealthReport({ state: this.disabled || this.state !== null && this.state.revocation !== "active" ? "disabled" : this.state?.retry_at !== null && this.state?.retry_at !== undefined && Date.parse(this.state.retry_at) > this.now().getTime() ? "rate_limited" : this.last,
      checked_at: this.now().toISOString(), detail: COVERAGE, last_success_at: this.lastSuccess });
  }
  private provider(): OAuthProvider {
    const client = this.config.client_id;
    if (typeof client !== "string" || client.length === 0 || client.length > 512 || /[^\x21-\x7e]/.test(client)) throw failure("misconfigured");
    return { name: X_API_CONNECTOR_ID, authorization_url: "https://x.com/i/oauth2/authorize", token_url: `${X_API_ORIGIN}/2/oauth2/token`,
      revocation_url: `${X_API_ORIGIN}/2/oauth2/revoke`, client_id: client, scopes: [...X_API_SCOPES] };
  }
  private selected(): XApiSelection { if (this.config.selection === undefined) throw failure("misconfigured"); return selection(this.config.selection); }
  private live(generation = this.generation): void { if (this.disabled || this.reloadRequired || generation !== this.generation) throw failure("unavailable"); }
  private idle(): void { this.live(); if (this.busy || this.pendingTokens > 0 || this.pendingWrites > 0) throw failure("unavailable"); }
  private require(): XApiState { this.live(); if (this.state === null || this.session === null || this.state.revocation !== "active") throw failure("unauthenticated"); return this.state; }
  private invalidate(generation: number): void {
    if (generation !== this.generation) return;
    this.generation++; this.reloadRequired = true; this.last = "unauthenticated";
    this.session?.forget(); this.session = null; this.state = null; this.custody = null;
  }
  private budget(duration?: number): ApiBudget { return new ApiBudget(this.deps.clock, duration); }
  private tokenTransport(generation: number): OAuthTransport {
    return { listen: path => this.transport.listen(path), postForm: (url, form) => {
      this.live(generation);
      const admission = this.admission;
      if (admission === null || admission.budget !== this.operationBudget ||
        ![`${X_API_ORIGIN}/2/oauth2/token`, `${X_API_ORIGIN}/2/oauth2/revoke`].includes(url)) throw failure("unavailable");
      try { admission.budget.requestMs(); }
      catch (error) { admission.refusal = normalizedFailure(error); throw error; }
      const custody = this.custody;
      if (custody === null) throw failure("misconfigured");
      return this.transport.postForm(url, form).then(async response => {
        if (response.status === 429) {
          // The core transport does not expose headers. Preserve a bounded
          // default cooldown through original custody, including late delivery.
          await this.commitCustody(custody, { ...custody.state, retry_at: new Date(this.now().getTime() + 60_000).toISOString() }, generation);
          admission.rateLimited = true;
        }
        return response;
      });
    } };
  }
  private async commitCustody(custody: Custody, next: XApiState, generation: number): Promise<void> {
    this.pendingWrites++;
    try {
      await custody.persist(encodeState(next)); custody.state = next;
      if (generation === this.generation && !this.disabled && !this.reloadRequired) this.state = next;
    } finally { this.pendingWrites--; }
  }
  private async persist(next: XApiState, budget: ApiBudget, generation = this.generation): Promise<void> {
    this.live(generation);
    const custody = this.custody;
    if (custody === null) throw failure("misconfigured");
    const bytes = encodeState(next), ms = Math.min(X_API_REQUEST_MS, budget.remaining());
    this.pendingWrites++;
    const pending = Promise.resolve().then(() => { this.live(generation); return custody.persist(bytes); }).then(() => { custody.state = next; })
      .finally(() => { this.pendingWrites--; });
    try { await withDeadline(pending, ms, "X persistence deadline"); this.live(generation); this.state = next; }
    catch (error) { this.invalidate(generation); throw failure(error instanceof DeadlineError ? "timeout" : "unavailable"); }
  }
  async connect(resolve: SecretResolver): Promise<void> {
    if (this.disabled || this.busy || this.pendingWrites > 0 || this.pendingTokens > 0) throw failure("unavailable");
    const provider = this.provider(), selected = this.selected();
    if (this.config.secret_ref === undefined || this.deps.persist === undefined) throw failure("misconfigured");
    this.busy = true; const generation = ++this.generation, budget = this.budget();
    this.session?.forget(); this.state = null; this.session = null; this.custody = null; this.reloadRequired = false; this.operationBudget = budget;
    try {
      const bytes = await withDeadline(resolve(this.config.secret_ref), Math.min(X_API_REQUEST_MS, budget.remaining()), "X state read deadline");
      this.live(generation);
      const state = parseState(new TextEncoder().encode(bytes));
      if (state.app !== digest(provider.client_id) || digest(state.selection) !== digest(selected) ||
        this.config.expected_account !== undefined && state.oauth.account.id !== this.config.expected_account) throw failure("identity_mismatch");
      const custody: Custody = { state, persist: this.deps.persist }; this.state = state; this.custody = custody;
      if (state.revocation !== "active") { this.last = "disabled"; return; }
      this.session = new OAuthSession({ provider, state: state.oauth, transport: this.tokenTransport(generation), now: this.now,
        persist: async bytes => {
          const oauth = parseOAuthState(bytes, X_API_CONNECTOR_ID);
          if (oauth.account.id !== custody.state.oauth.account.id) throw failure("identity_mismatch");
          await this.commitCustody(custody, { ...custody.state, oauth }, generation);
        } });
      if (state.retry_at === null || Date.parse(state.retry_at) <= this.now().getTime()) {
        if (parseAccount(await this.call(new URL(`${X_API_ORIGIN}/2/users/me`), budget)) !== state.oauth.account.id) throw failure("identity_mismatch");
      }
      this.last = "degraded";
    } catch (error) {
      if (failureRule(error) === "rate_limited" && generation === this.generation && this.state !== null && !this.reloadRequired) { this.last = "rate_limited"; return; }
      this.invalidate(generation); throw error instanceof DeadlineError ? failure("timeout") : normalizedFailure(error);
    }
    finally { this.operationBudget = null; this.busy = false; }
  }
  async signIn(io: SignInIo, writer: ConnectionStateWriter) {
    this.idle();
    if (this.state?.revocation === "pending") throw failure("unavailable");
    const provider = this.provider(), selected = this.selected();
    // The native registered callback is a separate qualification gate. Only
    // a trusted explicitly supplied transport may attempt interactive enrollment.
    if (this.deps.oauth === undefined) throw failure("misconfigured");
    this.busy = true;
    const generation = this.generation, budget = this.budget(120_000), previous = this.state;
    let active = true;
    let listener: Awaited<ReturnType<OAuthTransport["listen"]>> | null = null;
    const transport: OAuthTransport = {
      listen: async path => {
        const pending = this.transport.listen(path).then(opened => {
          if (!active) { void opened.close().catch(() => undefined); throw failure("timeout"); }
          listener = opened; return opened;
        });
        return withDeadline(pending, budget.remaining(), "X callback deadline");
      },
      postForm: async (url, form) => {
        if (!active || url !== provider.token_url) throw failure("unavailable");
        this.live(generation); const ms = budget.requestMs(); this.pendingTokens++;
        const pending = (async () => this.transport.postForm(url, form))().finally(() => { this.pendingTokens--; });
        return withDeadline(pending, ms, "X authorization exchange deadline");
      },
    };
    try {
      const flow = (async () => {
        const tokens = await signInWithBrowser(provider, io, transport, { timeoutMs: budget.remaining(), now: this.now });
        if (!active) throw failure("timeout"); this.live(generation);
        if (!X_API_SCOPES.every(scope => tokens.scope.split(/\s+/).includes(scope)) || tokens.refresh_token === null) throw failure("unauthenticated");
        const account = parseAccount(await request(new URL(`${X_API_ORIGIN}/2/users/me`), tokens.access_token, budget, this.deps.fetch, () => this.now().getTime()));
        if (!active) throw failure("timeout"); this.live(generation);
        if (this.config.expected_account !== undefined && account !== this.config.expected_account || previous !== null &&
          (previous.oauth.account.id !== account || previous.app !== digest(provider.client_id) || digest(previous.selection) !== digest(selected))) throw failure("identity_mismatch");
        const state: XApiState = { schema: X_API_STATE_SCHEMA, app: digest(provider.client_id), selection: selected,
          oauth: { schema: "kizuki.oauth-state/v1", provider: X_API_CONNECTOR_ID, account: { id: account, display: "X account" }, tokens, written_at: this.now().toISOString() },
          checkpoint: previous?.checkpoint ?? null, pending: previous?.pending ?? null, retry_at: previous?.retry_at ?? null, revocation: "active" };
        const bytes = encodeState(state), ms = Math.min(X_API_REQUEST_MS, budget.remaining());
        this.invalidate(generation); const targetGeneration = this.generation; this.pendingWrites++;
        const assertActive = () => { if (!active || this.disabled || this.generation !== targetGeneration) throw failure("unavailable"); };
        const pending = Promise.resolve().then(() => { assertActive(); return writer.write(bytes); }).finally(() => { this.pendingWrites--; });
        await withDeadline(pending, ms, "X enrollment persistence deadline"); assertActive();
        return { display: "X account" };
      })();
      return await withDeadline(flow, budget.remaining(), "X sign-in deadline");
    } catch (error) { throw error instanceof DeadlineError ? failure("timeout") : normalizedFailure(error); }
    finally { active = false; if (listener !== null) void (listener as Awaited<ReturnType<OAuthTransport["listen"]>>).close().catch(() => undefined); this.busy = false; }
  }
  private async token<T>(start: () => Promise<T>, budget: ApiBudget): Promise<T> {
    const generation = this.generation, ms = Math.min(X_API_REQUEST_MS, budget.remaining()), admission: TokenAdmission = { budget, refusal: null, rateLimited: false };
    this.admission = admission; this.pendingTokens++;
    const pending = Promise.resolve().then(() => { this.live(generation); return start(); }).finally(() => { this.pendingTokens--; });
    try { const result = await withDeadline(pending, ms, "X token deadline"); this.live(generation); return result; }
    catch (error) {
      if (admission.refusal !== null) throw admission.refusal;
      if (admission.rateLimited && generation === this.generation && !this.disabled && !this.reloadRequired) { this.last = "rate_limited"; throw failure("rate_limited"); }
      this.invalidate(generation); throw failure(error instanceof DeadlineError ? "timeout" : "unauthenticated");
    } finally { if (this.admission === admission) this.admission = null; }
  }
  private async call(url: URL, budget: ApiBudget): Promise<Record<string, unknown>> {
    this.require(); const generation = this.generation, session = this.session!;
    let access = await this.token(() => session.accessToken(), budget);
    try {
      let response: Record<string, unknown>;
      try { response = await request(url, access, budget, this.deps.fetch, () => this.now().getTime()); }
      catch (error) {
        if (!(error instanceof HttpFailure) || error.status !== 401) throw error;
        await this.token(() => session.refresh(), budget);
        access = await this.token(() => session.accessToken(), budget);
        response = await request(url, access, budget, this.deps.fetch, () => this.now().getTime());
      }
      this.live(generation); return response;
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 401) { this.invalidate(generation); throw failure("unauthenticated"); }
      if (error instanceof HttpFailure && error.status === 429) {
        const retry = new Date(this.now().getTime() + (error.retrySeconds ?? 60) * 1000).toISOString();
        await this.persist({ ...this.require(), retry_at: retry }, budget); this.last = "rate_limited"; throw failure("rate_limited");
      }
      if (error instanceof HttpFailure && error.status === 402) throw failure("billing_required");
      if (error instanceof HttpFailure && error.status === 403) throw failure("permission_denied");
      throw error;
    }
  }
  backfill(cursor: string | null = null): Promise<SyncBatch> { return this.run(cursor); }
  sync(cursor: string | null): Promise<SyncBatch> { return this.run(cursor); }
  private initial(account: string, selected: XApiSelection, committed: string | null): XApiCursor {
    const end = this.now().toISOString();
    if (compareInstants(end, selected.history_start) <= 0) throw failure("misconfigured");
    return { schema: X_API_CURSOR_SCHEMA, account, selection: digest(selected), phase: "walk", committed, lower: committed, end,
      newest: null, next: null, pages: 0, seen: [], restarts: 0 };
  }
  private async page(base: XApiCursor, selected: XApiSelection, budget: ApiBudget): Promise<{ page: XApiPage; base: XApiCursor }> {
    const fetchPage = async (cursor: XApiCursor) => {
      const query = fieldsQuery(selected); query.set("max_results", "100"); query.set("start_time", selected.history_start); query.set("end_time", cursor.end);
      if (cursor.lower !== null) query.set("since_id", cursor.lower);
      if (cursor.next !== null) query.set("pagination_token", cursor.next);
      const raw = await this.call(new URL(`${X_API_ORIGIN}/2/users/${cursor.account}/tweets?${query}`), budget);
      const page = parsePage(raw, cursor.account, selected, this.now().toISOString());
      if (page.events.some(event => compareInstants(event.occurred_at, selected.history_start) < 0 || compareInstants(event.occurred_at, cursor.end) > 0)) throw failure("pagination_gap");
      return page;
    };
    try { return { page: await fetchPage(base), base }; }
    catch (error) {
      // A previously issued continuation can be rejected after it expires.
      // Restart that exact frozen window once; never advance its lower bound.
      if (!(error instanceof HttpFailure) || error.status !== 400 || base.next === null || base.restarts !== 0) throw error;
      const restarted = { ...base, next: null, seen: [], restarts: 1 };
      return { page: await fetchPage(restarted), base: restarted };
    }
  }
  private next(base: XApiCursor, page: XApiPage): XApiCursor {
    if (page.events.some(event => base.lower !== null && BigInt(event.source_record_id.slice(5)) <= BigInt(base.lower))) throw failure("pagination_gap");
    const newest = page.newest === null || base.newest !== null && BigInt(base.newest) > BigInt(page.newest) ? base.newest : page.newest;
    if (page.next === null) return { ...base, phase: "idle", committed: newest ?? base.committed, lower: null, newest: null, next: null, pages: 0, seen: [], restarts: 0 };
    if (base.pages >= MAX_WALK_PAGES || base.seen.includes(digest(page.next))) throw failure("pagination_gap");
    return { ...base, newest, next: page.next, pages: base.pages + 1, seen: [...base.seen, digest(page.next)] };
  }
  private async replay(plan: XApiPlan, state: XApiState, budget: ApiBudget): Promise<SyncBatch> {
    if (plan.entries.length === 0) return { events: [], cursor: plan.next, detail: coverageDetail(plan.next) };
    const query = fieldsQuery(state.selection); query.set("ids", plan.entries.map(entry => entry.id).join(","));
    const page = parsePage(await this.call(new URL(`${X_API_ORIGIN}/2/tweets?${query}`), budget), state.oauth.account.id, state.selection, plan.observed, "lookup");
    if (digest(page.events.map(event => ({ id: event.source_record_id.slice(5), hash: digest(event) }))) !== digest(plan.entries)) throw failure("snapshot_changed");
    return { events: page.events, cursor: plan.next, detail: coverageDetail(plan.next) };
  }
  private async run(cursor: string | null): Promise<SyncBatch> {
    if (cursor !== null) parseCursor(cursor);
    if (this.disabled || this.busy || this.pendingTokens > 0 || this.pendingWrites > 0) throw failure("unavailable");
    this.busy = true;
    const budget = this.budget(); this.operationBudget = budget;
    try {
      let state = this.require();
      if (state.retry_at !== null && Date.parse(state.retry_at) > this.now().getTime()) throw failure("rate_limited");
      if (cursor !== state.checkpoint && cursor !== state.pending?.next) throw failure("invalid_cursor");
      if (parseAccount(await this.call(new URL(`${X_API_ORIGIN}/2/users/me`), budget)) !== state.oauth.account.id) { this.invalidate(this.generation); throw failure("identity_mismatch"); }
      state = this.require();
      if (state.pending !== null && cursor === state.pending.base) return await this.replay(state.pending, state, budget);
      if (state.pending !== null) { await this.persist({ ...state, checkpoint: state.pending.next, pending: null, retry_at: null }, budget); state = this.require(); }
      const decoded = cursor === null ? null : parseCursor(cursor);
      const base = decoded === null || decoded.phase === "idle" ? this.initial(state.oauth.account.id, state.selection, decoded?.committed ?? null) : decoded;
      const fetched = await this.page(base, state.selection, budget), next = encodeCursor(this.next(fetched.base, fetched.page));
      const observed = fetched.page.events[0]?.observed_at ?? this.now().toISOString();
      if (next !== cursor) {
        const draft = { base: cursor, next, observed, entries: fetched.page.events.map(event => ({ id: event.source_record_id.slice(5), hash: digest(event) })) };
        await this.persist({ ...this.require(), pending: { id: planDigest(draft), ...draft }, retry_at: null }, budget);
      } else if (fetched.page.events.length !== 0) throw failure("pagination_gap");
      this.last = "degraded"; this.lastSuccess = this.now().toISOString();
      return { events: fetched.page.events, cursor: next, detail: coverageDetail(next) };
    } catch (error) {
      const rule = failureRule(error);
      if (this.state !== null) this.last = rule === "unreachable" ? "unreachable" : rule === "rate_limited" ? "rate_limited" : "degraded";
      return { events: [], cursor, status: "unavailable", detail: error instanceof HttpFailure ? failure("provider_error").message : normalizedFailure(error).message };
    } finally { this.operationBudget = null; this.busy = false; }
  }
  /** Provider authorization revocation is explicit; it does not delete provider content. */
  async revokeProviderAccess(): Promise<void> {
    this.idle(); const state = this.state;
    if (state === null) throw failure("unauthenticated");
    this.busy = true; const budget = this.budget(); this.operationBudget = budget;
    try {
      if (state.revocation === "revoked") return;
      if (state.revocation === "active") await this.persist({ ...state, revocation: "pending" }, budget);
      if (state.retry_at !== null && Date.parse(state.retry_at) > this.now().getTime()) throw failure("rate_limited");
      const tokens = state.oauth.tokens;
      for (const token of [tokens.refresh_token!, tokens.access_token]) {
        await this.token(() => revokeToken(this.provider(), token, this.tokenTransport(this.generation)), budget);
      }
      await this.persist({ ...this.state!, revocation: "revoked", retry_at: null }, budget);
    } finally { await this.close(); this.operationBudget = null; this.busy = false; }
  }
  /** Contract revoke is immediate local cessation, including during provider failure. */
  async revoke(): Promise<void> { await this.close(); }
  async close(): Promise<void> { this.disabled = true; this.generation++; this.session?.forget(); this.session = null; this.state = null; this.custody = null; }
  async purgeSource(_subject: string): Promise<never> { throw failure("not_supported"); }
  async fixture() {
    return parsePage({ data: [{ id: "100", author_id: "7", created_at: "2026-01-02T00:00:00Z", text: "Synthetic own post." }], meta: { result_count: 1 } },
      "7", selection({ fields: [], history_start: "2026-01-01T00:00:00Z", wire_profile: "tweet-v2" }), "2026-01-03T00:00:00Z").events;
  }
}
export function createXApiConnector(config: XApiConfig = {}, deps: XApiDeps = {}): XApiConnector { return new XApiConnector(config, deps); }
