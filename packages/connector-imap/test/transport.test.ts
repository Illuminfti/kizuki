import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KizukiError } from "@kizuki/core";
import { dialTls, hostnameMatches } from "../src/transport";

describe("hostname verification", () => {
  test.each([
    ["mail.acme.example", "DNS:mail.acme.example", true],
    ["MAIL.acme.example", "DNS:mail.acme.example", true],
    ["mail.acme.example", "DNS:*.acme.example", true],
    ["acme.example", "DNS:*.acme.example", false],
    ["a.b.acme.example", "DNS:*.acme.example", false],
    ["mail.acme.example", "DNS:mail.other.example", false],
    ["mail.acme.example", "DNS:other.example, DNS:mail.acme.example", true],
    ["127.0.0.1", "IP Address:127.0.0.1", true],
    ["127.0.0.1", "DNS:127.0.0.1", false],
    ["127.0.0.1", "IP Address:10.0.0.1", false],
  ])("%s against %s", (host, subjectaltname, expected) => {
    expect(hostnameMatches(host, { subjectaltname })).toBe(expected);
  });

  test("falls back to the common name only when there is no SAN at all", () => {
    expect(
      hostnameMatches("mail.acme.example", {
        subject: { CN: "mail.acme.example" },
      }),
    ).toBe(true);
    expect(
      hostnameMatches("mail.acme.example", {
        subjectaltname: "DNS:other.example",
        subject: { CN: "mail.acme.example" },
      }),
    ).toBe(false);
    expect(hostnameMatches("mail.acme.example", {})).toBe(false);
  });
});

const openssl = Bun.which("openssl");

interface Certificate {
  key: string;
  cert: string;
}

const directories: string[] = [];

function generateCertificate(): Certificate {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-imap-tls-"));
  directories.push(directory);
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  const result = Bun.spawnSync({
    cmd: [
      openssl ?? "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `certificate generation failed: ${result.stderr.toString()}`,
    );
  }
  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
  };
}

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const suite = openssl === null ? describe.skip : describe;

suite("the TLS gate over loopback", () => {
  test("rejects an untrusted certificate before a byte is written", async () => {
    const certificate = generateCertificate();
    const received: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: certificate,
      socket: {
        open(socket) {
          socket.write("* OK loopback ready\r\n");
        },
        data(_socket, buffer) {
          received.push(new TextDecoder().decode(buffer));
        },
      },
    });
    try {
      const error = await dialTls("localhost", server.port, {
        timeoutMs: 5_000,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KizukiError);
      expect((error as KizukiError).code).toBe("unreachable");
      expect((error as KizukiError).message).toBe(
        "tls: DEPTH_ZERO_SELF_SIGNED_CERT",
      );
      expect(received).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("delivers the greeting once the anchor and the name both check out", async () => {
    const certificate = generateCertificate();
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: certificate,
      socket: {
        open(socket) {
          socket.write("* OK loopback ready\r\n");
        },
        data() {},
      },
    });
    try {
      const conn = await dialTls("localhost", server.port, {
        timeoutMs: 5_000,
        ca: certificate.cert,
      });
      const chunk = await conn.receive();
      expect(new TextDecoder().decode(chunk ?? new Uint8Array())).toBe(
        "* OK loopback ready\r\n",
      );
      conn.close();
    } finally {
      server.stop(true);
    }
  });

  test("rejects a trusted certificate issued for another name", async () => {
    const certificate = generateCertificate();
    const received: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: certificate,
      socket: {
        open(socket) {
          socket.write("* OK loopback ready\r\n");
        },
        data(_socket, buffer) {
          received.push(new TextDecoder().decode(buffer));
        },
      },
    });
    try {
      const error = await dialTls("127.0.0.1", server.port, {
        timeoutMs: 5_000,
        ca: certificate.cert,
      }).catch((caught: unknown) => caught);
      expect((error as KizukiError).message).toBe(
        "tls: certificate does not match host",
      );
      expect(received).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("times out against a server that accepts and never speaks", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data() {},
      },
    });
    try {
      const started = Date.now();
      const error = await dialTls("127.0.0.1", server.port, {
        timeoutMs: 150,
      }).catch((caught: unknown) => caught);
      expect((error as KizukiError).message).toBe("connect timed out");
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      server.stop(true);
    }
  });
});
