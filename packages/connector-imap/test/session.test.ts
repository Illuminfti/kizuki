import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import { ImapSession } from "../src/imap/session";
import type { ImapConn, ImapDialer } from "../src/transport";
import type { ImapState } from "../src/state";

const STATE: ImapState = {
  schema: "kizuki.imap-state/v1",
  host: "mail.acme.example",
  port: 993,
  username: "ada@acme.example",
  password: "app-password",
  folders: ["INBOX"],
  max_message_bytes: 2_097_152,
};

/** Answers the opening handshake, then whatever the test scripted. */
function dialer(replies: (command: string) => string[]): ImapDialer {
  return async (): Promise<ImapConn> => {
    const pending: Uint8Array[] = ["* OK ready\r\n"].map((text) =>
      new TextEncoder().encode(text),
    );
    const waiters: ((chunk: Uint8Array | null) => void)[] = [];
    let closed = false;
    const push = (text: string): void => {
      const bytes = new TextEncoder().encode(text);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(bytes);
      else pending.push(bytes);
    };
    return {
      async send(bytes) {
        const line = new TextDecoder().decode(bytes);
        const tag = line.split(" ")[0] ?? "";
        const verb = (line.split(" ")[1] ?? "").toUpperCase();
        if (verb === "CAPABILITY") {
          push(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
          return;
        }
        if (verb === "LOGIN") {
          push(`${tag} OK signed in\r\n`);
          return;
        }
        for (const reply of replies(line)) push(reply.replace("{tag}", tag));
      },
      async receive() {
        const chunk = pending.shift();
        if (chunk !== undefined) return chunk;
        if (closed) return null;
        return new Promise<Uint8Array | null>((resolve) => waiters.push(resolve));
      },
      close() {
        closed = true;
        while (waiters.length > 0) waiters.shift()?.(null);
      },
    };
  };
}

async function summaries(replies: string[]): Promise<unknown> {
  const session = await ImapSession.open(dialer(() => replies), STATE);
  return session.fetchSummaries("1:10").catch((caught: unknown) => caught);
}

describe("fetch summaries", () => {
  test("accepts a complete row", async () => {
    const result = await summaries([
      '* 1 FETCH (UID 7 INTERNALDATE "01-Mar-2026 10:00:00 +0000" RFC822.SIZE 120)\r\n',
      "{tag} OK done\r\n",
    ]);
    expect(result).toEqual([
      { uid: 7, internaldate: "01-Mar-2026 10:00:00 +0000", size: 120 },
    ]);
  });

  test.each([
    ["a missing size", "* 1 FETCH (UID 7 INTERNALDATE \"01-Mar-2026 10:00:00 +0000\")\r\n", "server omitted the size"],
    ["a missing internaldate", "* 1 FETCH (UID 7 RFC822.SIZE 120)\r\n", "server omitted the internaldate"],
    ["an unreadable internaldate", '* 1 FETCH (UID 7 INTERNALDATE "yesterday" RFC822.SIZE 120)\r\n', "server sent a malformed internaldate"],
    ["a zero uid", '* 1 FETCH (UID 0 INTERNALDATE "01-Mar-2026 10:00:00 +0000" RFC822.SIZE 120)\r\n', "server sent a malformed uid"],
    ["a fractional size", '* 1 FETCH (UID 7 INTERNALDATE "01-Mar-2026 10:00:00 +0000" RFC822.SIZE 1.5)\r\n', "server sent a malformed size"],
  ])("refuses %s", async (_name, row, message) => {
    const error = await summaries([row, "{tag} OK done\r\n"]);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("protocol");
    expect((error as KizukiError).message).toBe(message);
  });

  test("refuses two rows for one uid", async () => {
    const row = '* 1 FETCH (UID 7 INTERNALDATE "01-Mar-2026 10:00:00 +0000" RFC822.SIZE 120)\r\n';
    const error = await summaries([row, row, "{tag} OK done\r\n"]);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).message).toBe("server listed a uid twice");
  });
});

describe("fetch bodies", () => {
  test("refuses a body for a message nobody asked about", async () => {
    const session = await ImapSession.open(
      dialer(() => [
        "* 1 FETCH (UID 99 BODY[] {2}\r\nhi)\r\n",
        "{tag} OK done\r\n",
      ]),
      STATE,
    );
    const error = await session
      .fetchBodies([7], "")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).message).toBe("server sent an unrequested body");
  });
});
