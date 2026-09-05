/** Synthetic-only transport and opaque state for public connector conformance. */
import { KizukiError, type StatePersister } from "@kizuki/core";
import { createGmailConnector } from "./connector";
import { encodeState, FIELDS, GMAIL_CONNECTOR_ID, GMAIL_SCOPES } from "./state";
export class GmailFixture {
    state: Uint8Array;
    readonly requests: string[] = [];
    readonly missing = new Set<string>();
    readonly messages = new Map<string, Record<string, unknown>>();
    account = "fixture-account";
    expired = false;
    failStatus = 0;
    beforeRequest: ((request: Request) => Promise<void>) | undefined;
    private time = new Date("2024-01-01T00:00:00.000Z");
    private history = 100n;
    private readonly changes: Record<string, unknown>[] = [];
    constructor(count = 2) {
        this.state = encodeState({ schema: "kizuki.gmail-state/v1", oauth: { schema: "kizuki.oauth-state/v1", provider: GMAIL_CONNECTOR_ID, account: { id: "fixture-account", display: "Synthetic account" }, tokens: { access_token: "synthetic-access-not-a-credential", refresh_token: "synthetic-refresh-not-a-credential", expires_at: "2099-01-01T00:00:00.000Z", scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" }, written_at: this.time.toISOString() }, fields: [...FIELDS], pending: null });
        for (let n = 1; n <= count; n++)
            this.messages.set(`m${n}`, { id: `m${n}`, threadId: `t${n}`, historyId: "100", internalDate: "1704067200000", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "sender@example.test" }, { name: "Subject", value: `Synthetic subject ${n}` }], body: { data: Buffer.from(`Synthetic message body ${n}`).toString("base64url") } } });
    }
    now = () => new Date(this.time);
    advanceDay() { this.time = new Date(this.time.getTime() + 86400000); }
    change(message: string, kind: "messagesAdded" | "messagesDeleted" | "labelsAdded" | "labelsRemoved") {
        this.history++;
        const current = this.messages.get(message);
        if (current)
            current.historyId = String(this.history);
        this.changes.push({ id: String(this.history), [kind]: [{ message: { id: message } }] });
        if (kind === "messagesDeleted")
            this.messages.delete(message);
    }
    persist: StatePersister = async (bytes) => { this.state = bytes.slice(); };
    fetch = async (request: Request): Promise<Response> => {
        this.requests.push(request.url);
        await this.beforeRequest?.(request);
        if (this.failStatus)
            return Response.json({ error: "SECRET_SENTINEL" }, { status: this.failStatus });
        const url = new URL(request.url);
        if (url.hostname === "openidconnect.googleapis.com")
            return Response.json({ sub: this.account });
        const path = url.pathname.split("/users/me/")[1];
        if (path === "profile")
            return Response.json({ historyId: String(this.history) });
        if (path === "messages") {
            const start = Number(url.searchParams.get("pageToken") ?? 0), all = [...this.messages.keys()];
            return Response.json({ messages: all.slice(start, start + 20).map(id => ({ id })), ...(all.length > start + 20 ? { nextPageToken: String(start + 20) } : {}) });
        }
        if (path === "history") {
            if (this.expired) {
                this.expired = false;
                return Response.json({}, { status: 404 });
            }
            const all = this.changes.filter(c => BigInt(c.id as string) > BigInt(url.searchParams.get("startHistoryId")!)), start = Number(url.searchParams.get("pageToken") ?? 0);
            return Response.json({ history: all.slice(start, start + 20), historyId: String(this.history), ...(all.length > start + 20 ? { nextPageToken: String(start + 20) } : {}) });
        }
        if (path?.startsWith("messages/")) {
            const key = decodeURIComponent(path.slice(9)), message = this.messages.get(key);
            return message && !this.missing.has(key) ? Response.json(message) : Response.json({}, { status: 404 });
        }
        throw new Error("Unexpected synthetic Gmail request");
    };
    async connected(persist: StatePersister = this.persist) {
        const connector = createGmailConnector({ client: { id: "synthetic-desktop-client" }, secret_ref: "file:synthetic-state", fields: FIELDS }, { fetch: this.fetch, persist, now: this.now, oauth: { listen: async () => { throw new KizukiError("timeout", "Synthetic browser cancellation"); }, postForm: async () => { throw new KizukiError("unauthenticated", "Synthetic refresh unavailable"); } } });
        await connector.connect(async () => new TextDecoder().decode(this.state));
        return connector;
    }
}
