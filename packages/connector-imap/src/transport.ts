import { KizukiError } from "@kizuki/core";

export interface ImapConn {
  send(bytes: Uint8Array): Promise<void>;
  /** Next chunk from the server; `null` once the peer is done. */
  receive(): Promise<Uint8Array | null>;
  close(): void;
}

export interface DialOptions {
  timeoutMs: number;
  /**
   * Trust anchor for the loopback transport test only. No owner-facing path
   * sets it: `parseImapState` refuses any field that is not in its schema.
   */
  ca?: string;
}

export type ImapDialer = (
  host: string,
  port: number,
  opts: DialOptions,
) => Promise<ImapConn>;

export interface PeerCertificate {
  subjectaltname?: string;
  subject?: { CN?: string };
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(":");
}

function dnsMatches(pattern: string, host: string): boolean {
  const candidate = pattern.toLowerCase();
  const target = host.toLowerCase().replace(/\.$/, "");
  if (!candidate.startsWith("*.")) return candidate === target;
  // A wildcard is only ever the whole leftmost label and only ever covers one
  // label: `*.example.org` is not a licence for `a.b.example.org`.
  const suffix = candidate.slice(2);
  const separator = target.indexOf(".");
  if (separator === -1) return false;
  return target.slice(separator + 1) === suffix && suffix.length > 0;
}

/**
 * RFC 6125 subset. Bun does not fail a handshake on a name mismatch, so this
 * is the only thing standing between the owner and a server that answered for
 * somebody else's certificate.
 */
export function hostnameMatches(host: string, cert: PeerCertificate): boolean {
  const entries = (cert.subjectaltname ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const dnsNames = entries
    .filter((entry) => entry.toLowerCase().startsWith("dns:"))
    .map((entry) => entry.slice(4).trim());
  const ipNames = entries
    .filter((entry) => entry.toLowerCase().startsWith("ip address:"))
    .map((entry) => entry.slice("ip address:".length).trim());

  if (isIpLiteral(host)) return ipNames.includes(host);
  if (entries.length > 0) {
    return dnsNames.some((pattern) => dnsMatches(pattern, host));
  }
  const commonName = cert.subject?.CN;
  return commonName !== undefined && dnsMatches(commonName, host);
}

class QueueConn implements ImapConn {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: ((chunk: Uint8Array | null) => void)[] = [];
  private ended = false;
  private writer: ((bytes: Uint8Array) => void) | null = null;
  private closer: (() => void) | null = null;

  attach(writer: (bytes: Uint8Array) => void, closer: () => void): void {
    this.writer = writer;
    this.closer = closer;
  }

  push(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(chunk);
      return;
    }
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(null);
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.writer === null) {
      throw new KizukiError("unreachable", "connection is not writable");
    }
    this.writer(bytes);
  }

  async receive(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk !== undefined) return chunk;
    if (this.ended) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.end();
    this.closer?.();
    this.closer = null;
    this.writer = null;
  }
}

function tlsFailure(detail: string): KizukiError {
  return new KizukiError("unreachable", `tls: ${detail}`);
}

/**
 * The single socket in this package. Bun reports a rejected certificate
 * through `authorizationError` while still calling back with `success` and
 * `socket.authorized` true, so the gate below — not the runtime — decides
 * whether a byte is ever written. Nothing in this tree turns verification off.
 */
export const dialTls: ImapDialer = async (host, port, opts) => {
  const conn = new QueueConn();
  return new Promise<ImapConn>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.close();
      reject(new KizukiError("unreachable", "connect timed out"));
    }, opts.timeoutMs);

    const fail = (error: KizukiError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.close();
      reject(error);
    };

    Bun.connect({
      hostname: host,
      port,
      tls: {
        serverName: host,
        rejectUnauthorized: true,
        ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
      },
      socket: {
        open(socket) {
          conn.attach(
            (bytes) => {
              socket.write(bytes);
            },
            () => {
              socket.end();
            },
          );
        },
        handshake(socket, _success, authorizationError) {
          if (authorizationError !== null && authorizationError !== undefined) {
            const reason =
              (authorizationError as { code?: string }).code ??
              authorizationError.message;
            fail(tlsFailure(reason));
            return;
          }
          const certificate = socket.getPeerCertificate() as PeerCertificate;
          if (!hostnameMatches(host, certificate)) {
            fail(tlsFailure("certificate does not match host"));
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(conn);
        },
        data(_socket, buffer) {
          conn.push(new Uint8Array(buffer));
        },
        close() {
          conn.end();
        },
        end() {
          conn.end();
        },
        error(_socket, error) {
          fail(tlsFailure((error as { code?: string }).code ?? error.message));
        },
        connectError(_socket, error) {
          fail(
            new KizukiError(
              "unreachable",
              `connect failed: ${(error as { code?: string }).code ?? error.message}`,
            ),
          );
        },
      },
    }).catch((error: unknown) => {
      fail(
        new KizukiError(
          "unreachable",
          `connect failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });
};
