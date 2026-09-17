import { failure, object } from './state';
export const ORIGIN = 'https://api.prod.whoop.com';
export type WhoopFetch = (request: Request) => Promise<Response>;
const ROUTES = new Set(['/developer/v2/user/profile/basic', '/developer/v2/cycle', '/developer/v2/recovery', '/developer/v2/activity/sleep', '/developer/v2/activity/workout', '/developer/v2/user/access']);
export class HttpFailure extends Error {
    constructor(readonly status: number, readonly retrySeconds: number | null = null) {
        super('WHOOP request refused');
    }
}
export class Budget {
    private readonly deadline = Date.now() + 45000;
    private calls = 0;
    get exhausted(): boolean {
        return this.calls >= 48;
    }
    get exceeded(): boolean {
        return this.calls > 48;
    }
    remaining(): number {
        const left = this.deadline - Date.now();
        if (left <= 0)
            throw failure('timeout');
        return left;
    }
    requestMs(): number {
        if (++this.calls > 48)
            throw failure('request_limit');
        return Math.min(5000, this.remaining());
    }
}
function retry(response: Response): number {
    const raw = response.headers.get('retry-after');
    if (raw && /^\d{1,10}$/.test(raw))
        return Math.max(1, Number(raw));
    // Date.parse also accepts malformed delays such as "-1" as calendar dates.
    // The longest HTTP-date is RFC850 with Wednesday (33 characters).
    if (raw && raw.length <= 33 && /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(raw)) {
        // Resolve the year and delay against the same wall-clock instant.
        const now = Date.now();
        let time: number;
        // RFC 9110: resolve a two-digit RFC850 year to the most recent matching
        // year no more than 50 years in the future; Date.parse's fixed
        // 1950/2049 pivot turns valid future cooldowns into the past.
        const shortYear = /-(\d{2}) /.exec(raw);
        if (shortYear) {
            const limitDate = new Date(now);
            limitDate.setUTCFullYear(limitDate.getUTCFullYear() + 50);
            const suffix = Number(shortYear[1]);
            let year = Math.floor((limitDate.getUTCFullYear() - suffix) / 100) * 100 + suffix;
            let parsed = Date.parse(raw.replace(/-\d{2} /, `-${year} `));
            if (parsed > limitDate.getTime()) {
                year -= 100;
                parsed = Date.parse(raw.replace(/-\d{2} /, `-${year} `));
            }
            time = parsed;
        } else {
            // asctime has no zone suffix, but HTTP dates always denote GMT.
            time = Date.parse(raw.includes(',') ? raw : `${raw} GMT`);
        }
        if (Number.isFinite(time)) {
            // Round-trip every HTTP-date form: Date.parse normalizes invalid days
            // and ignores mismatched weekdays, which can shorten the cooldown.
            const date = new Date(time), utc = date.toUTCString();
            const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()];
            const rfc850 = `${weekday}, ${utc.slice(5, 7)}-${utc.slice(8, 11)}-${utc.slice(14, 16)} ${utc.slice(17)}`;
            const asctime = `${utc.slice(0, 3)} ${utc.slice(8, 11)} ${String(date.getUTCDate()).padStart(2, ' ')} ${utc.slice(17, 25)} ${utc.slice(12, 16)}`;
            // HTTP's asctime day permits both 2DIGIT and SP DIGIT.
            const paddedAsctime = `${asctime.slice(0, 8)}${String(date.getUTCDate()).padStart(2, '0')}${asctime.slice(10)}`;
            if (raw === utc || raw === rfc850 || raw === asctime || raw === paddedAsctime)
                return Math.max(1, Math.ceil((time - now) / 1000));
        }
    }
    // WHOOP's reset header is a delay in seconds, never an HTTP date.
    const reset = response.headers.get('x-ratelimit-reset');
    return reset && /^\d{1,10}$/.test(reset) ? Math.max(1, Number(reset)) : 60;
}
async function read(response: Response): Promise<unknown> {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2 * 1024 * 1024)) {
        void response.body?.cancel().catch(() => {
        });
        throw failure('response_limit');
    }
    ;
    if (!response.body)
        throw failure();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.length;
            if (size > 2 * 1024 * 1024)
                throw failure('response_limit');
            chunks.push(part.value);
        }
    }
    finally {
        void reader.cancel().catch(() => {
        });
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', {
            fatal: true
        }).decode(bytes));
    }
    catch {
        throw failure();
    }
}
/** Exact sanctioned routes, no redirects or raw provider diagnostics. */
export async function request(url: URL, token: string, budget: Budget, fetcher: WhoopFetch = (r) => fetch(r), method: 'GET' | 'DELETE' = 'GET'): Promise<Record<string, unknown>> {
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !ROUTES.has(url.pathname) || (method === 'DELETE') !== (url.pathname === '/developer/v2/user/access') || url.href.length > 4096)
        throw failure('misconfigured');
    const requestMs = budget.requestMs();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(failure('timeout'));
                }, requestMs);
            }), (async () => {
                const response = await fetcher(new Request(url, {
                    method, redirect: 'error', headers: {
                        Authorization: `Bearer ${token}`, Accept: 'application/json'
                    }, signal: controller.signal
                }));
                if (response.status !== (method === 'DELETE' ? 204 : 200)) {
                    void response.body?.cancel().catch(() => {
                    });
                    throw new HttpFailure(response.status, response.status === 429 ? retry(response) : null);
                }
                if (method === 'DELETE') {
                    void response.body?.cancel().catch(() => {
                    });
                    return {};
                }
                return object(await read(response));
            })()]);
    }
    catch (error) {
        if (error instanceof HttpFailure || (error instanceof Error && error.name === 'KizukiError'))
            throw error;
        throw failure('unreachable');
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}
