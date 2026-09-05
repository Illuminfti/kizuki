import { failure, object } from "./state";
export type GmailFetch = (request: Request) => Promise<Response>;
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me/";
export const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export class HttpFailure extends Error {
    constructor(readonly status: number) { super("Gmail HTTP request refused"); }
}
/** Per-method wall clock and request budget; one instance is never reused. */
export class Budget {
    readonly deadline = Date.now() + 45000;
    private calls = 0;
    remaining(): number { const left = this.deadline - Date.now(); if (left <= 0)
        throw failure("timeout"); return left; }
    requestMs(): number { if (++this.calls > 25)
        throw failure("unavailable"); return Math.min(5000, this.remaining()); }
}
async function read(response: Response): Promise<unknown> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        await response.body?.cancel();
        throw failure();
    }
    if (!response.body)
        throw failure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw failure();
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        throw failure();
    }
}
/** Fixed Google GET endpoints only. Redirects never receive the bearer token. */
export async function getJson(url: URL, token: string, budget: Budget, transport: GmailFetch = request => fetch(request)): Promise<Record<string, unknown>> {
    if (!(url.href === USERINFO || url.href.startsWith(GMAIL_API)) || url.username || url.password || url.hash)
        throw failure("misconfigured");
    const requestMs = budget.requestMs();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("timeout")); }, requestMs); });
        return await Promise.race([timeout, (async () => {
                let response: Response;
                try {
                    response = await transport(new Request(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: controller.signal }));
                }
                catch {
                    throw failure("unreachable");
                }
                if (response.status !== 200) {
                    if (response.status === 403) {
                        const body = object(await read(response));
                        const errors = object(body.error).errors;
                        if (Array.isArray(errors) && errors.some(entry => ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(object(entry).reason as string)))
                            throw failure("rate_limited");
                        throw failure("provider_error");
                    }
                    await response.body?.cancel();
                    if (response.status === 429)
                        throw failure("rate_limited");
                    throw new HttpFailure(response.status);
                }
                return object(await read(response));
            })()]);
    }
    catch (error) {
        if (error instanceof HttpFailure || (error instanceof Error && error.name === "KizukiError"))
            throw error;
        throw failure("unreachable");
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}
