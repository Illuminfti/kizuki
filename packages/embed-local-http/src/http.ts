export type HttpFailureKind =
  "timeout" | "network" | "too_large" | "malformed" | "redirect" | "status" | "aborted";

export class HttpFailure extends Error {
  override readonly name = "HttpFailure";
  constructor(
    readonly kind: HttpFailureKind,
    readonly status: number = 0,
  ) {
    super(kind === "status" ? `http ${status}` : kind);
  }
}

export interface JsonPost {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly body: unknown;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  readonly signal?: AbortSignal;
}

const HEAD_END = new Uint8Array([13, 10, 13, 10]);
const MAX_HEAD_BYTES = 16_384;

function indexOfSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  outer: for (let at = from; at <= haystack.length - needle.length; at += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[at + offset] !== needle[offset]) continue outer;
    }
    return at;
  }
  return -1;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let at = 0;
  for (;;) {
    const lineEnd = indexOfSequence(body, new Uint8Array([13, 10]), at);
    if (lineEnd < 0) throw new HttpFailure("malformed");
    const sizeText = new TextDecoder()
      .decode(body.subarray(at, lineEnd))
      .split(";")[0]!
      .trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText))
      throw new HttpFailure("malformed");
    const size = parseInt(sizeText, 16);
    at = lineEnd + 2;
    if (size === 0) return concat(parts, total);
    if (at + size + 2 > body.length) throw new HttpFailure("malformed");
    parts.push(body.subarray(at, at + size));
    total += size;
    at += size + 2;
  }
}

function parseResponse(raw: Uint8Array): { status: number; body: Uint8Array } {
  const headEnd = indexOfSequence(raw, HEAD_END);
  if (headEnd < 0 || headEnd > MAX_HEAD_BYTES)
    throw new HttpFailure("malformed");
  const lines = new TextDecoder()
    .decode(raw.subarray(0, headEnd))
    .split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "");
  if (status === null) throw new HttpFailure("malformed");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new HttpFailure("malformed");
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  const code = Number(status[1]);
  const rest = raw.subarray(headEnd + HEAD_END.length);
  if (
    headers.get("transfer-encoding")?.toLowerCase().includes("chunked") === true
  ) {
    return { status: code, body: decodeChunked(rest) };
  }
  const announced = headers.get("content-length");
  if (announced === undefined) return { status: code, body: rest };
  if (!/^\d+$/.test(announced)) throw new HttpFailure("malformed");
  const length = Number(announced);
  if (rest.length < length) throw new HttpFailure("malformed");
  return { status: code, body: rest.subarray(0, length) };
}

/**
 * POST one JSON document to an address literal and return the parsed reply.
 * The socket goes to `host:port` and nowhere else: unlike the fetch API and
 * Node's HTTP client, this never consults `HTTP_PROXY`, so loopback text cannot be
 * rerouted to a proxy. The reply is read to the end of the connection, capped
 * at `max_response_bytes`, and a redirect is a failure.
 */
export function postJson(request: JsonPost): Promise<unknown> {
  const payload = new TextEncoder().encode(JSON.stringify(request.body));
  const hostHeader = request.host.includes(":")
    ? `[${request.host}]`
    : request.host;
  const head = new TextEncoder().encode(
    `POST ${request.path} HTTP/1.1\r\nHost: ${hostHeader}:${request.port}\r\n` +
      `Accept: application/json\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${payload.byteLength}\r\nConnection: close\r\n\r\n`,
  );
  const outgoing = concat(
    [head, payload],
    head.byteLength + payload.byteLength,
  );

  return new Promise<unknown>((resolve, reject) => {
    const received: Uint8Array[] = [];
    let total = 0;
    let written = 0;
    let settled = false;
    let socket:
      | { end(): void; terminate(): void; write(data: Uint8Array): number }
      | undefined;

    const settle = (outcome: () => unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      try {
        socket?.terminate();
      } catch {
        /* the peer may already be gone */
      }
      try {
        resolve(outcome());
      } catch (error) {
        reject(error);
      }
    };
    const fail = (kind: HttpFailureKind): void =>
      settle(() => {
        throw new HttpFailure(kind);
      });
    const abort = (): void => fail("aborted");
    const timer = setTimeout(() => fail("timeout"), request.timeout_ms);
    const flush = (target: { write(data: Uint8Array): number }): void => {
      if (written < outgoing.byteLength)
        written += target.write(outgoing.subarray(written));
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) { abort(); return; }

    Bun.connect({
      hostname: request.host,
      port: request.port,
      socket: {
        open(target) {
          socket = target;
          // A deadline that fired while the connection was pending has already settled.
          if (settled) target.terminate();
          else flush(target);
        },
        drain(target) {
          if (!settled) flush(target);
        },
        data(_target, chunk) {
          if (settled) return;
          total += chunk.byteLength;
          if (total > request.max_response_bytes + MAX_HEAD_BYTES) {
            fail("too_large");
            return;
          }
          received.push(new Uint8Array(chunk));
        },
        close() {
          settle(() => {
            const reply = parseResponse(concat(received, total));
            if (reply.status >= 300 && reply.status < 400)
              throw new HttpFailure("redirect", reply.status);
            if (reply.status < 200 || reply.status >= 300)
              throw new HttpFailure("status", reply.status);
            if (reply.body.byteLength > request.max_response_bytes)
              throw new HttpFailure("too_large");
            try {
              return JSON.parse(
                new TextDecoder().decode(reply.body),
              ) as unknown;
            } catch {
              throw new HttpFailure("malformed");
            }
          });
        },
        error() {
          fail("network");
        },
        connectError() {
          fail("network");
        },
      },
    }).catch(() => fail("network"));
  });
}
