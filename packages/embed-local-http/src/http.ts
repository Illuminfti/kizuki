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
const CRLF = new Uint8Array([13, 10]);
const MAX_HEAD_BYTES = 16_384;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

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
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Decodes an HTTP/1.1 chunked body. Returns `null` when more bytes are needed
 * before the terminating `0\r\n...\r\n` frame is complete.
 */
function tryDecodeChunked(
  body: Uint8Array,
  eof: boolean,
): { body: Uint8Array; consumed: number } | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  let at = 0;
  for (;;) {
    const lineEnd = indexOfSequence(body, CRLF, at);
    if (lineEnd < 0) {
      if (eof) throw new HttpFailure("malformed");
      return null;
    }
    const sizeText = DECODER.decode(body.subarray(at, lineEnd))
      .split(";")[0]!
      .trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText))
      throw new HttpFailure("malformed");
    const size = parseInt(sizeText, 16);
    at = lineEnd + 2;
    if (size === 0) {
      // Terminating chunk ends with empty trailer line (\r\n) or trailer headers + \r\n\r\n.
      if (at + 2 <= body.length && body[at] === 13 && body[at + 1] === 10) {
        return { body: concat(parts, total), consumed: at + 2 };
      }
      const trailerEnd = indexOfSequence(body, HEAD_END, at);
      if (trailerEnd >= 0) {
        return { body: concat(parts, total), consumed: trailerEnd + 4 };
      }
      if (eof) return { body: concat(parts, total), consumed: body.length };
      return null;
    }
    if (at + size + 2 > body.length) {
      if (eof) throw new HttpFailure("malformed");
      return null;
    }
    if (body[at + size] !== 13 || body[at + size + 1] !== 10) {
      throw new HttpFailure("malformed");
    }
    parts.push(body.subarray(at, at + size));
    total += size;
    at += size + 2;
  }
}

interface ParsedHeaders {
  readonly version: string;
  readonly status: number;
  readonly headEnd: number;
  readonly chunked: boolean;
  readonly contentLength: number | null;
  readonly keepAlive: boolean;
}

function parseHeaders(raw: Uint8Array): ParsedHeaders | null {
  const headEnd = indexOfSequence(raw, HEAD_END);
  if (headEnd < 0) {
    if (raw.byteLength > MAX_HEAD_BYTES) throw new HttpFailure("malformed");
    return null;
  }
  if (headEnd > MAX_HEAD_BYTES) throw new HttpFailure("malformed");
  const lines = DECODER.decode(raw.subarray(0, headEnd)).split("\r\n");
  const status = /^HTTP\/(1\.[01]) (\d{3})(?: |$)/.exec(lines[0] ?? "");
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
  const version = status[1]!;
  const code = Number(status[2]);
  const chunked =
    headers.get("transfer-encoding")?.toLowerCase().includes("chunked") === true;
  let contentLength: number | null = null;
  if (!chunked) {
    const announced = headers.get("content-length");
    if (announced !== undefined) {
      if (!/^\d+$/.test(announced)) throw new HttpFailure("malformed");
      contentLength = Number(announced);
    }
  }
  const conn = headers.get("connection")?.toLowerCase() ?? "";
  const keepAlive =
    version === "1.1" ? !conn.includes("close") : conn.includes("keep-alive");
  return { version, status: code, headEnd, chunked, contentLength, keepAlive };
}

function finalizeReply(
  status: number,
  body: Uint8Array,
  maxResponseBytes: number,
): unknown {
  if (status >= 300 && status < 400) throw new HttpFailure("redirect", status);
  if (status < 200 || status >= 300) throw new HttpFailure("status", status);
  if (body.byteLength > maxResponseBytes) throw new HttpFailure("too_large");
  try {
    return JSON.parse(DECODER.decode(body)) as unknown;
  } catch {
    throw new HttpFailure("malformed");
  }
}

interface LoopbackSocket {
  end(): void;
  terminate(): void;
  write(data: Uint8Array): number;
  ref?(): void;
  unref?(): void;
}

interface ActiveExchange {
  outgoing: Uint8Array;
  written: number;
  received: Uint8Array[];
  total: number;
  headers: ParsedHeaders | null;
  maxResponseBytes: number;
  onComplete(status: number, body: Uint8Array, canReuse: boolean): void;
  onError(kind: HttpFailureKind, receivedBytes: number): void;
  onClose(receivedBytes: number): void;
}

interface PooledConnection {
  readonly host: string;
  readonly port: number;
  readonly socket: LoopbackSocket;
  exchange: ActiveExchange | null;
  closed: boolean;
}

function buildRequestBytes(request: JsonPost, keepAlive: boolean): Uint8Array {
  const payload = ENCODER.encode(JSON.stringify(request.body));
  const hostHeader = request.host.includes(":")
    ? `[${request.host}]`
    : request.host;
  const head = ENCODER.encode(
    `POST ${request.path} HTTP/1.1\r\nHost: ${hostHeader}:${request.port}\r\n` +
      `Accept: application/json\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${payload.byteLength}\r\n` +
      `Connection: ${keepAlive ? "keep-alive" : "close"}\r\n\r\n`,
  );
  return concat([head, payload], head.byteLength + payload.byteLength);
}

/**
 * Single-socket loopback HTTP/1.1 keep-alive client.
 * Connects directly to `host:port` via `Bun.connect` so `HTTP_PROXY` is never
 * consulted. Reuses an idle loopback connection across sequential requests and
 * retries once on a clean keep-alive EOF before any response bytes arrive.
 */
export class LoopbackJsonClient {
  private idle: PooledConnection | null = null;

  close(): void {
    const conn = this.idle;
    this.idle = null;
    if (conn !== null) {
      conn.closed = true;
      try {
        conn.socket.terminate();
      } catch {
        /* peer may already be gone */
      }
    }
  }

  async post(request: JsonPost): Promise<unknown> {
    const startedAt = Date.now();
    const pooled = this.takeIdle(request.host, request.port);
    if (pooled !== null) {
      try {
        return await this.send(request, pooled, request.timeout_ms, true);
      } catch (error) {
        // Retry once on a fresh socket if the idle keep-alive socket was closed
        // by the peer before sending any response bytes.
        if (
          !(error instanceof StaleKeepAliveError) ||
          request.signal?.aborted === true
        ) {
          throw error instanceof StaleKeepAliveError
            ? new HttpFailure("network")
            : error;
        }
        const remaining = request.timeout_ms - (Date.now() - startedAt);
        if (remaining <= 0) throw new HttpFailure("timeout");
        return this.send(request, null, remaining, false);
      }
    }
    return this.send(request, null, request.timeout_ms, false);
  }

  private takeIdle(host: string, port: number): PooledConnection | null {
    const conn = this.idle;
    this.idle = null;
    if (conn === null || conn.closed) return null;
    if (conn.host === host && conn.port === port) return conn;
    conn.closed = true;
    try {
      conn.socket.terminate();
    } catch {
      /* peer may already be gone */
    }
    return null;
  }

  private returnIdle(conn: PooledConnection): void {
    if (conn.closed) return;
    if (this.idle !== null && this.idle !== conn) {
      const old = this.idle;
      old.closed = true;
      try {
        old.socket.terminate();
      } catch {
        /* ignore */
      }
    }
    conn.exchange = null;
    conn.socket.unref?.();
    this.idle = conn;
  }

  private send(
    request: JsonPost,
    reused: PooledConnection | null,
    timeoutMs: number,
    isReused: boolean,
  ): Promise<unknown> {
    const outgoing = buildRequestBytes(request, true);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let conn: PooledConnection | null = reused;

      const terminateConn = (): void => {
        if (conn === null) return;
        const target = conn;
        conn = null;
        target.exchange = null;
        target.closed = true;
        if (this.idle === target) this.idle = null;
        try {
          target.socket.terminate();
        } catch {
          /* the peer may already be gone */
        }
      };

      const settle = (outcome: () => unknown, keepSocket = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        if (keepSocket && conn !== null && !conn.closed) {
          this.returnIdle(conn);
        } else {
          terminateConn();
        }
        try {
          resolve(outcome());
        } catch (error) {
          reject(error);
        }
      };

      const fail = (error: Error): void =>
        settle(() => {
          throw error;
        }, false);
      const abort = (): void => fail(new HttpFailure("aborted"));
      const timer = setTimeout(
        () => fail(new HttpFailure("timeout")),
        Math.max(1, timeoutMs),
      );

      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) {
        abort();
        return;
      }

      const exchange: ActiveExchange = {
        outgoing,
        written: 0,
        received: [],
        total: 0,
        headers: null,
        maxResponseBytes: request.max_response_bytes,
        onComplete: (status, body, canReuse) => {
          const reuse = canReuse && status >= 200 && status < 300;
          settle(
            () => finalizeReply(status, body, request.max_response_bytes),
            reuse,
          );
        },
        onError: (kind, receivedBytes) => {
          if (isReused && receivedBytes === 0 && kind === "network") {
            fail(new StaleKeepAliveError());
          } else {
            fail(new HttpFailure(kind));
          }
        },
        onClose: (receivedBytes) => {
          if (isReused && receivedBytes === 0) {
            fail(new StaleKeepAliveError());
            return;
          }
          settle(() => {
            const raw = concat(exchange.received, exchange.total);
            const hdrs = exchange.headers ?? parseHeaders(raw);
            if (hdrs === null) throw new HttpFailure("malformed");
            const rest = raw.subarray(hdrs.headEnd + HEAD_END.length);
            if (hdrs.chunked) {
              const decoded = tryDecodeChunked(rest, true);
              if (decoded === null) throw new HttpFailure("malformed");
              return finalizeReply(
                hdrs.status,
                decoded.body,
                request.max_response_bytes,
              );
            }
            if (hdrs.contentLength !== null) {
              if (rest.byteLength < hdrs.contentLength)
                throw new HttpFailure("malformed");
              return finalizeReply(
                hdrs.status,
                rest.subarray(0, hdrs.contentLength),
                request.max_response_bytes,
              );
            }
            return finalizeReply(hdrs.status, rest, request.max_response_bytes);
          }, false);
        },
      };

      const flush = (target: LoopbackSocket): void => {
        if (exchange.written < exchange.outgoing.byteLength) {
          exchange.written += target.write(
            exchange.outgoing.subarray(exchange.written),
          );
        }
      };

      if (conn !== null) {
        conn.exchange = exchange;
        conn.socket.ref?.();
        try {
          flush(conn.socket);
        } catch {
          exchange.onError("network", 0);
        }
        return;
      }

      let created: PooledConnection | null = null;
      const clearIdleIf = (target: PooledConnection): void => {
        if (this.idle === target) this.idle = null;
      };
      Bun.connect({
        hostname: request.host,
        port: request.port,
        socket: {
          open(target) {
            created = {
              host: request.host,
              port: request.port,
              socket: target,
              exchange: null,
              closed: false,
            };
            if (settled) {
              created.closed = true;
              target.terminate();
              return;
            }
            conn = created;
            created.exchange = exchange;
            flush(target);
          },
          drain(target) {
            const active = created?.exchange;
            if (active === null || active === undefined) return;
            if (active.written < active.outgoing.byteLength) {
              active.written += target.write(
                active.outgoing.subarray(active.written),
              );
            }
          },
          data(target, chunk) {
            const active = created?.exchange;
            if (active === null || active === undefined) {
              // Unexpected bytes while idle: drop the socket immediately.
              if (created !== null) {
                created.closed = true;
                clearIdleIf(created);
              }
              try {
                target.terminate();
              } catch {
                /* ignore */
              }
              return;
            }
            active.total += chunk.byteLength;
            if (active.total > active.maxResponseBytes + MAX_HEAD_BYTES) {
              active.onError("too_large", active.total);
              return;
            }
            active.received.push(new Uint8Array(chunk));
            try {
              const raw = concat(active.received, active.total);
              active.received = [raw];
              if (active.headers === null) {
                active.headers = parseHeaders(raw);
                if (active.headers === null) return;
                if (
                  active.headers.contentLength !== null &&
                  active.headers.contentLength > active.maxResponseBytes
                ) {
                  active.onError("too_large", active.total);
                  return;
                }
              }
              const hdrs = active.headers;
              const bodyOffset = hdrs.headEnd + HEAD_END.length;
              const bodyView = raw.subarray(bodyOffset);
              if (hdrs.chunked) {
                const decoded = tryDecodeChunked(bodyView, false);
                if (decoded !== null) {
                  const exact = decoded.consumed === bodyView.byteLength;
                  active.onComplete(
                    hdrs.status,
                    decoded.body,
                    hdrs.keepAlive && exact,
                  );
                }
              } else if (hdrs.contentLength !== null) {
                if (bodyView.byteLength >= hdrs.contentLength) {
                  const exact = bodyView.byteLength === hdrs.contentLength;
                  active.onComplete(
                    hdrs.status,
                    bodyView.subarray(0, hdrs.contentLength),
                    hdrs.keepAlive && exact,
                  );
                }
              }
            } catch (error) {
              active.onError(
                error instanceof HttpFailure ? error.kind : "malformed",
                active.total,
              );
            }
          },
          close() {
            if (created !== null) {
              created.closed = true;
              clearIdleIf(created);
              const active = created.exchange;
              created.exchange = null;
              if (active !== null) active.onClose(active.total);
            } else {
              exchange.onClose(exchange.total);
            }
          },
          error() {
            if (created !== null) {
              created.closed = true;
              clearIdleIf(created);
              const active = created.exchange;
              created.exchange = null;
              if (active !== null) active.onError("network", active.total);
            } else {
              exchange.onError("network", exchange.total);
            }
          },
          connectError() {
            if (created !== null) created.closed = true;
            exchange.onError("network", 0);
          },
        },
      }).catch(() => exchange.onError("network", 0));
    });
  }
}

class StaleKeepAliveError extends Error {
  override readonly name = "StaleKeepAliveError";
}

/**
 * POST one JSON document to an address literal and return the parsed reply.
 * The socket goes to `host:port` and nowhere else: unlike the fetch API and
 * Node's HTTP client, this never consults `HTTP_PROXY`, so loopback text cannot be
 * rerouted to a proxy. The reply is read to the end of the connection, capped
 * at `max_response_bytes`, and a redirect is a failure.
 */
export function postJson(request: JsonPost): Promise<unknown> {
  const outgoing = buildRequestBytes(request, false);

  return new Promise<unknown>((resolve, reject) => {
    const received: Uint8Array[] = [];
    let total = 0;
    let written = 0;
    let settled = false;
    let socket: LoopbackSocket | undefined;

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
    if (request.signal?.aborted) {
      abort();
      return;
    }

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
            const raw = concat(received, total);
            const hdrs = parseHeaders(raw);
            if (hdrs === null) throw new HttpFailure("malformed");
            const rest = raw.subarray(hdrs.headEnd + HEAD_END.length);
            if (hdrs.chunked) {
              const decoded = tryDecodeChunked(rest, true);
              if (decoded === null) throw new HttpFailure("malformed");
              return finalizeReply(
                hdrs.status,
                decoded.body,
                request.max_response_bytes,
              );
            }
            if (hdrs.contentLength !== null) {
              if (rest.byteLength < hdrs.contentLength)
                throw new HttpFailure("malformed");
              return finalizeReply(
                hdrs.status,
                rest.subarray(0, hdrs.contentLength),
                request.max_response_bytes,
              );
            }
            return finalizeReply(hdrs.status, rest, request.max_response_bytes);
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
