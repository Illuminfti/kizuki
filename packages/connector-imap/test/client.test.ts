import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";
import { ImapClient, MAX_UNTAGGED, atom, str } from "../src/imap/client";
import { failureFor, sanitizeDetail } from "../src/imap/codes";
import type { ImapConn } from "../src/transport";

interface Scripted extends ImapConn {
  sent: string[];
  closed: boolean;
  push(text: string): void;
}

function scripted(reply: (text: string, index: number) => string[]): Scripted {
  const pending: Uint8Array[] = [];
  const waiters: ((chunk: Uint8Array | null) => void)[] = [];
  const push = (text: string): void => {
    const bytes = new TextEncoder().encode(text);
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(bytes);
    else pending.push(bytes);
  };
  const conn: Scripted = {
    sent: [],
    closed: false,
    push,
    async send(bytes) {
      const text = new TextDecoder().decode(bytes);
      conn.sent.push(text);
      for (const response of reply(text, conn.sent.length - 1)) push(response);
    },
    async receive() {
      const chunk = pending.shift();
      if (chunk !== undefined) return chunk;
      if (conn.closed) return null;
      return new Promise<Uint8Array | null>((resolve) => waiters.push(resolve));
    },
    close() {
      conn.closed = true;
      while (waiters.length > 0) waiters.shift()?.(null);
    },
  };
  return conn;
}

const BELL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

describe("command correlation", () => {
  test("collects interleaved untagged responses until the tagged reply", async () => {
    const conn = scripted(() => [
      "* 3 EXISTS\r\n",
      "* OK [UIDVALIDITY 7] ok\r\n",
      "A0001 OK done\r\n",
    ]);
    const result = await new ImapClient(conn).send("NOOP");
    expect(result.untagged).toHaveLength(2);
    expect(result.tagged.tag).toBe("A0001");
    expect(conn.sent[0]).toBe("A0001 NOOP\r\n");
  });

  test("increments the tag per command", async () => {
    const conn = scripted((text) => [
      `${text.split(" ")[0] ?? ""} OK done\r\n`,
    ]);
    const client = new ImapClient(conn);
    await client.send("NOOP");
    await client.send("NOOP");
    expect(conn.sent.map((line) => line.split(" ")[0])).toEqual([
      "A0001",
      "A0002",
    ]);
  });
});

describe("argument encoding", () => {
  test("escapes a quote and a backslash inline", async () => {
    const conn = scripted(() => ["A0001 OK done\r\n"]);
    await new ImapClient(conn).send("LOGIN", [
      str("ada@acme.example"),
      str('pw-with-quote"-and\\slash'),
    ]);
    expect(conn.sent[0]).toBe(
      'A0001 LOGIN "ada@acme.example" "pw-with-quote\\"-and\\\\slash"\r\n',
    );
  });

  test("sends a non-ASCII value as a literal after the continuation", async () => {
    const conn = scripted((_text, index) =>
      index === 0
        ? ["+ go ahead\r\n"]
        : index === 2
          ? ["A0001 OK done\r\n"]
          : [],
    );
    await new ImapClient(conn).send("LOGIN", [
      str("ada@acme.example"),
      str("pw-with-ünïcode"),
    ]);
    expect(conn.sent[0]).toBe('A0001 LOGIN "ada@acme.example" {17}\r\n');
    expect(conn.sent[1]).toBe("pw-with-ünïcode");
    expect(conn.sent[2]).toBe("\r\n");
  });

  test("accepts an untagged response before the continuation request", async () => {
    const conn = scripted((_text, index) =>
      index === 0
        ? ["* OK [ALERT] scheduled maintenance tonight\r\n", "+ go ahead\r\n"]
        : index === 2
          ? ["A0001 OK LOGIN completed\r\n"]
          : [],
    );
    const result = await new ImapClient(conn).send(
      "LOGIN",
      [str("ada@acme.example"), str("pw-with-ünïcode")],
      { login: true },
    );
    expect(result.tagged.text).toBe("OK LOGIN completed");
    expect(result.untagged.map((response) => response.text)).toEqual([
      "OK [ALERT] scheduled maintenance tonight",
    ]);
  });

  test("a tagged reply instead of a continuation is still a refusal", async () => {
    const conn = scripted((_text, index) =>
      index === 0 ? ["A0001 NO [AUTHENTICATIONFAILED] nope\r\n"] : [],
    );
    const error = await new ImapClient(conn)
      .send("LOGIN", [str("ada"), str("pw-with-ünïcode")], { login: true })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("unauthenticated");
  });

  test("an endless untagged stream before a continuation is refused", async () => {
    const conn = scripted((_text, index) =>
      index === 0
        ? Array.from({ length: MAX_UNTAGGED + 1 }, () => "* OK chatter\r\n")
        : [],
    );
    const error = await new ImapClient(conn)
      .send("LOGIN", [str("ada"), str("pw-with-ünïcode")])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).message).toBe("too many untagged responses");
  });

  test("refuses a reply whose responses add up past the command budget", async () => {
    const body = "x".repeat(512);
    const conn = scripted(() => [
      ...Array.from(
        { length: 40 },
        (_value, uid) => `* ${uid + 1} FETCH (UID ${uid + 1} BODY[] {512}\r\n${body})\r\n`,
      ),
      "A0001 OK done\r\n",
    ]);
    // Every line, literal and response here is inside its own bound, and the
    // count is far under MAX_UNTAGGED; only the total is out of hand.
    const client = new ImapClient(conn, { commandByteBudget: 4_096 });
    const error = await client
      .send("UID FETCH", [atom("1:40"), atom("(BODY.PEEK[])")])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("protocol");
    expect((error as KizukiError).message).toBe("reply exceeds the command budget");
    expect(conn.closed).toBe(true);
  });

  test("counts the budget per command, not per connection", async () => {
    const body = "y".repeat(200);
    const conn = scripted((text) => [
      `* 1 FETCH (UID 1 BODY[] {200}\r\n${body})\r\n`,
      `${text.split(" ")[0] ?? ""} OK done\r\n`,
    ]);
    const client = new ImapClient(conn, { commandByteBudget: 1_024 });
    for (let round = 0; round < 5; round += 1) {
      const result = await client.send("UID FETCH", [atom("1"), atom("(BODY.PEEK[])")]);
      expect(result.untagged).toHaveLength(1);
    }
    expect(conn.closed).toBe(false);
  });

  test("sends a value containing CRLF as a literal", async () => {
    const conn = scripted((_text, index) =>
      index === 0
        ? ["+ go ahead\r\n"]
        : index === 2
          ? ["A0001 OK done\r\n"]
          : [],
    );
    await new ImapClient(conn).send("LOGIN", [str("ada"), str("a\r\nb")]);
    expect(conn.sent[0]).toBe('A0001 LOGIN "ada" {4}\r\n');
  });

  test("refuses a NUL byte before writing anything", async () => {
    const conn = scripted(() => []);
    await expect(
      new ImapClient(conn).send("LOGIN", [str("ada"), str(`a${NUL}b`)]),
    ).rejects.toThrow(KizukiError);
    expect(conn.sent).toEqual([]);
  });

  test("passes an atom through unquoted", async () => {
    const conn = scripted(() => ["A0001 OK done\r\n"]);
    await new ImapClient(conn).send("UID FETCH", [atom("1:5"), atom("(UID)")]);
    expect(conn.sent[0]).toBe("A0001 UID FETCH 1:5 (UID)\r\n");
  });

  test("refuses an atom carrying a character the line cannot hold", async () => {
    const conn = scripted(() => []);
    const error = await new ImapClient(conn)
      .send("UID SEARCH", [atom('FROM "a\u030db@acme.example"')])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("misconfigured");
    expect(conn.sent).toEqual([]);
  });

  test("a combining mark in a quoted value travels as a literal", async () => {
    const conn = scripted((_text, index) =>
      index === 0 ? ["+ go ahead\r\n"] : ["A0001 OK done\r\n"],
    );
    await new ImapClient(conn).send("LOGIN", [str("ada"), str("a\u030ab")]);
    // Masked into a byte, U+030A would have been the LF that ends the line.
    expect(conn.sent[0]).toBe('A0001 LOGIN "ada" {4}\r\n');
    expect(conn.sent[1]).toBe("a\u030ab");
  });
});

describe("failure handling", () => {
  test("an untagged BYE closes the connection and is unreachable", async () => {
    const conn = scripted(() => ["* BYE shutting down\r\n"]);
    const client = new ImapClient(conn);
    await expect(client.send("NOOP")).rejects.toThrow("server said BYE");
    expect(conn.closed).toBe(true);
  });

  test("a command timeout closes the connection", async () => {
    const conn = scripted(() => []);
    const client = new ImapClient(conn, { commandTimeoutMs: 20 });
    const error = await client.send("NOOP").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("unreachable");
    expect(conn.closed).toBe(true);
  });

  test("a slow drip cannot hold a command open past its deadline", async () => {
    const conn = scripted(() => []);
    const client = new ImapClient(conn, { commandTimeoutMs: 60 });
    const started = Date.now();
    const drip = setInterval(() => {
      conn.push("* 1 EXISTS chatter\r\n");
    }, 10);
    const error = await client.send("NOOP").catch((caught: unknown) => caught);
    clearInterval(drip);
    expect((error as KizukiError).code).toBe("unreachable");
    expect((error as KizukiError).message).toBe("command timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(conn.closed).toBe(true);
  });

  test("an endless untagged stream is refused rather than buffered", async () => {
    const conn = scripted((text) =>
      text.startsWith("A0001")
        ? Array.from(
            { length: MAX_UNTAGGED + 10 },
            (_unused, index) => `* ${index + 1} EXISTS chatter\r\n`,
          )
        : [],
    );
    const client = new ImapClient(conn, { commandTimeoutMs: 5_000 });
    const error = await client.send("NOOP").catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("protocol");
    expect((error as KizukiError).message).toBe("too many untagged responses");
    expect(conn.closed).toBe(true);
  });

  test("a connection dropped mid-line is unreachable, not a response flood", async () => {
    let calls = 0;
    let handed = false;
    const conn: ImapConn = {
      async send() {},
      async receive() {
        calls += 1;
        if (handed) return null;
        handed = true;
        return new TextEncoder().encode("* OK partial");
      },
      close() {},
    };
    const error = await new ImapClient(conn)
      .send("NOOP")
      .catch((caught: unknown) => caught);
    expect((error as KizukiError).code).toBe("unreachable");
    expect(calls).toBeLessThan(10);
  });

  test("an EOF mid-command is unreachable", async () => {
    const conn = scripted(() => []);
    const client = new ImapClient(conn, { commandTimeoutMs: 5_000 });
    const pending = client.send("NOOP");
    conn.close();
    await expect(pending).rejects.toThrow("server closed the connection");
  });

  test.each<[string, KizukiErrorCode]>([
    ["[AUTHENTICATIONFAILED] Invalid credentials", "unauthenticated"],
    ["[AUTHORIZATIONFAILED] no", "unauthenticated"],
    ["[EXPIRED] rotate", "unauthenticated"],
    ["[PRIVACYREQUIRED] tls", "unauthenticated"],
    ["[LIMIT] too many", "rate_limited"],
    ["[INUSE] busy", "rate_limited"],
    ["[UNAVAILABLE] down", "unreachable"],
    ["[SERVERBUG] odd", "protocol"],
  ])("maps %s", (text, code) => {
    expect(failureFor(text, { login: false }).code).toBe(code);
  });

  test("an unmapped code during LOGIN is a fault, not a credential verdict", () => {
    expect(failureFor("[ALERT] mailbox is full", { login: true }).code).toBe(
      "protocol",
    );
    expect(failureFor("[SERVERBUG] oops", { login: true }).code).toBe(
      "protocol",
    );
    expect(failureFor("[LIMIT] too many", { login: true }).code).toBe(
      "rate_limited",
    );
  });

  test("a codeless NO to LOGIN is unauthenticated, elsewhere protocol", () => {
    expect(failureFor("no such user", { login: true }).code).toBe(
      "unauthenticated",
    );
    expect(failureFor("cannot do that", { login: false }).code).toBe(
      "protocol",
    );
  });

  test("the detail is sanitised and never names the command", async () => {
    const conn = scripted(() => [
      `A0001 NO [AUTHENTICATIONFAILED] bad ${BELL}${"x".repeat(400)}\r\n`,
    ]);
    const error = await new ImapClient(conn)
      .send("LOGIN", [str("ada"), str("secret")], { login: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KizukiError);
    const message = (error as KizukiError).message;
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).not.toContain(BELL);
    expect(message).not.toContain("LOGIN");
    expect(message).not.toContain("secret");
  });

  test("sanitizeDetail strips control characters and bounds the length", () => {
    expect(sanitizeDetail(`ab${BELL} c `)).toBe("ab c");
    expect(sanitizeDetail("y".repeat(500))).toHaveLength(200);
  });
});
