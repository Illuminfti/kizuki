import { KizukiError, type OAuthTransport, type SignInIo } from "@kizuki/core";
import { createXApiConnector, type XApiConfig, type XApiDeps } from "./connector";
import { X_API_CONNECTOR_ID, X_API_SCOPES, X_API_STATE_SCHEMA, digest, encodeState, selection, type XApiSelection } from "./state";

/** Synthetic API wire peer. Production package exports never expose this fixture. */
export class XApiFixture {
  readonly clientId = "synthetic-public-x-client";
  readonly account = "7";
  readonly selected: XApiSelection;
  state: Uint8Array;
  time = new Date("2026-02-01T00:00:00.000Z");
  records: Record<string, unknown>[];
  requests: Request[] = [];
  forms: { url: string; form: Record<string, string> }[] = [];
  notices: string[] = [];
  authorizations: URL[] = [];
  access = "SYNTHETIC_X_ACCESS_CANARY_0";
  refresh = "SYNTHETIC_X_REFRESH_CANARY_0";
  tokenCount = 0;
  readonly revokedTokens = new Set<string>();
  failStatus = 0;
  retryAfter = "60";
  authorize = false;
  wrongState = false;
  listenerClosed = false;
  before?: (request: Request) => Promise<Response | void>;
  beforeToken?: (url: string, form: Record<string, string>) => Promise<{ status: number; body: unknown } | void>;
  private callbackResolve: ((url: URL) => void) | null = null;
  constructor(count = 3, readonly pageSize = 2, selected: XApiSelection = selection({ fields: [], history_start: "2026-01-01T00:00:00Z", wire_profile: "tweet-v2" })) {
    this.selected = selection(selected);
    this.records = Array.from({ length: count }, (_, i) => ({ id: String(100 + i), author_id: this.account, text: `Synthetic own post ${i}.`,
      created_at: new Date(Date.parse("2026-01-02T00:00:00Z") + i * 1000).toISOString() }));
    this.state = encodeState({ schema: X_API_STATE_SCHEMA, app: digest(this.clientId), selection: this.selected, checkpoint: null, pending: null, retry_at: null, revocation: "active",
      oauth: { schema: "kizuki.oauth-state/v1", provider: X_API_CONNECTOR_ID, account: { id: this.account, display: "X account" }, written_at: this.time.toISOString(),
        tokens: { access_token: this.access, refresh_token: this.refresh, expires_at: "2027-01-01T00:00:00.000Z", scope: X_API_SCOPES.join(" "), token_type: "Bearer" } } });
  }
  readonly persist = async (bytes: Uint8Array): Promise<void> => { this.state = bytes.slice(); };
  readonly now = (): Date => new Date(this.time);
  readonly fetch = async (request: Request): Promise<Response> => {
    this.requests.push(request);
    const intercepted = await this.before?.(request); if (intercepted !== undefined) return intercepted;
    if (this.failStatus !== 0) return Response.json({ detail: "SYNTHETIC_PROVIDER_PROSE_CANARY" }, { status: this.failStatus, headers: { "retry-after": this.retryAfter } });
    const url = new URL(request.url);
    if (url.pathname === "/2/users/me") return Response.json({ data: { id: this.account, username: "synthetic_owner" } });
    if (url.pathname === "/2/tweets") {
      const requested = (url.searchParams.get("ids") ?? "").split(",");
      const data = this.records.filter(row => requested.includes(String(row.id))).map(row => structuredClone(row));
      return Response.json({ data, ...(data.length === requested.length ? {} : { errors: [{ detail: "SYNTHETIC_LOOKUP_MISSING_CANARY" }] }) });
    }
    if (url.pathname !== `/2/users/${this.account}/tweets`) throw Error("unexpected synthetic X route");
    const since = url.searchParams.get("since_id"), end = Date.parse(url.searchParams.get("end_time") ?? ""), start = Date.parse(url.searchParams.get("start_time") ?? "");
    const records = this.records.filter(row => (since === null || BigInt(String(row.id)) > BigInt(since)) &&
      (typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) || Date.parse(row.created_at) >= start && Date.parse(row.created_at) <= end))
      .sort((a, b) => BigInt(String(a.id)) > BigInt(String(b.id)) ? -1 : 1);
    const next = url.searchParams.get("pagination_token");
    const offset = next === null ? 0 : Number(next.replace(/^page-/, ""));
    if (!Number.isSafeInteger(offset) || offset < 0) return Response.json({}, { status: 400 });
    const data = records.slice(offset, offset + this.pageSize).map(row => structuredClone(row));
    return Response.json({ data, meta: { result_count: data.length,
      ...(data.length === 0 ? {} : { newest_id: data[0]!.id, oldest_id: data.at(-1)!.id }),
      ...(offset + this.pageSize < records.length ? { next_token: `page-${offset + this.pageSize}` } : {}) } });
  };
  readonly oauth: OAuthTransport = {
    listen: async path => {
      this.listenerClosed = false;
      return { redirect_uri: `http://127.0.0.1:49152${path}`,
        callback: () => this.authorize ? new Promise<URL>(resolve => { this.callbackResolve = resolve; }) : Promise.reject(new KizukiError("timeout", "synthetic cancelled enrollment")),
        close: async () => { this.listenerClosed = true; } };
    },
    postForm: async (url, form) => {
      this.forms.push({ url, form: { ...form } });
      const intercepted = await this.beforeToken?.(url, form); if (intercepted !== undefined) return intercepted;
      if (url.endsWith("/revoke")) { this.revokedTokens.add(form.token!); return { status: 200, body: { revoked: true } }; }
      if (url !== "https://api.x.com/2/oauth2/token" || !["refresh_token", "authorization_code"].includes(form.grant_type ?? "")) throw Error("unexpected synthetic OAuth request");
      if (form.grant_type === "refresh_token" && (form.refresh_token !== this.refresh || this.revokedTokens.has(form.refresh_token))) return { status: 400, body: { error: "invalid_grant" } };
      this.tokenCount++; this.access = `SYNTHETIC_X_ACCESS_CANARY_${this.tokenCount}`; this.refresh = `SYNTHETIC_X_REFRESH_CANARY_${this.tokenCount}`;
      return { status: 200, body: { access_token: this.access, refresh_token: this.refresh, expires_in: 7200, scope: X_API_SCOPES.join(" "), token_type: "Bearer" } };
    },
  };
  readonly io: SignInIo = {
    prompt: async () => { throw Error("X must not prompt for hidden application credentials"); },
    notify: text => { this.notices.push(text); },
    openUrl: async raw => {
      const url = new URL(raw); this.authorizations.push(url);
      const returned = new URL(url.searchParams.get("redirect_uri")!); returned.searchParams.set("code", "synthetic-auth-code");
      returned.searchParams.set("state", this.wrongState ? "wrong" : url.searchParams.get("state")!); this.callbackResolve?.(returned);
    },
  };
  config(secretRef = "env:KIZUKI_X_SYNTHETIC_STATE"): XApiConfig {
    return { client_id: this.clientId, secret_ref: secretRef, selection: this.selected, expected_account: this.account };
  }
  deps(overrides: XApiDeps = {}): XApiDeps { return { persist: this.persist, fetch: this.fetch, oauth: this.oauth, now: this.now, ...overrides }; }
  async connected(overrides: XApiDeps = {}) {
    const port = createXApiConnector(this.config(), this.deps(overrides));
    await port.connect(async () => new TextDecoder().decode(this.state)); return port;
  }
}
