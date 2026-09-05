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
    const raw = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset');
    if (raw && /^\d{1,10}$/.test(raw))
        return Math.max(1, Number(raw));
    if (raw) {
        const time = Date.parse(raw);
        if (Number.isFinite(time))
            return Math.max(1, Math.ceil((time - Date.now()) / 1000));
    }
    return 60;
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
