import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import {
  assertSameImapIdentity,
  DEFAULT_MAX_MESSAGE_BYTES,
  parseImapState,
  serializeImapState,
} from "../src/state";
import type { ImapState } from "../src/state";

const SECRET = 'pw-with-quote"-and-ünïcode';

const STATE: ImapState = {
  schema: "kizuki.imap-state/v1",
  host: "mail.acme.example",
  port: 993,
  username: "ada@acme.example",
  password: SECRET,
  folders: ["INBOX", "Archive"],
  max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
};

function reject(patch: Record<string, unknown>): KizukiError {
  const text = JSON.stringify({ ...STATE, ...patch });
  try {
    parseImapState(text);
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("connection state", () => {
  test("permits password rotation but refuses another mailbox without exposing it", () => {
    expect(() => assertSameImapIdentity(
      serializeImapState(STATE),
      serializeImapState({ ...STATE, password: "rotated" }),
    )).not.toThrow();
    let error: unknown;
    try {
      assertSameImapIdentity(serializeImapState(STATE), serializeImapState({ ...STATE, username: "other@example.test" }));
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("does not match");
    expect((error as Error).message).not.toContain("other@example.test");
  });
  test("round-trips through the serialized bytes", () => {
    const bytes = serializeImapState(STATE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(parseImapState(new TextDecoder().decode(bytes))).toEqual(STATE);
  });

  test("refuses a wrong schema, an unknown key and a missing key", () => {
    expect(reject({ schema: "kizuki.imap-state/v2" }).code).toBe("misconfigured");
    expect(reject({ extra: 1 }).message).toContain("unknown field");
    const missing = JSON.stringify({ ...STATE, host: undefined });
    expect(() => parseImapState(missing)).toThrow(KizukiError);
  });

  test("refuses a bad port", () => {
    for (const port of [0, 65536, "993", 993.5, -1]) {
      expect(reject({ port }).code).toBe("misconfigured");
    }
  });

  test("refuses empty strings, empty folders and duplicate folders", () => {
    expect(reject({ host: "" }).code).toBe("misconfigured");
    expect(reject({ username: "" }).code).toBe("misconfigured");
    expect(reject({ password: "" }).code).toBe("misconfigured");
    expect(reject({ folders: [] }).code).toBe("misconfigured");
    expect(reject({ folders: ["INBOX", "INBOX"] }).code).toBe("misconfigured");
    expect(reject({ folders: ["INBOX", ""] }).code).toBe("misconfigured");
    expect(reject({ folders: "INBOX" }).code).toBe("misconfigured");
  });

  test("refuses a bad max_message_bytes and malformed json", () => {
    expect(reject({ max_message_bytes: 0 }).code).toBe("misconfigured");
    expect(reject({ max_message_bytes: 1.5 }).code).toBe("misconfigured");
    expect(() => parseImapState("")).toThrow(KizukiError);
    expect(() => parseImapState("{")).toThrow(KizukiError);
    expect(() => parseImapState("[]")).toThrow(KizukiError);
  });

  test("no rejection message ever echoes a field value", () => {
    const messages = [
      reject({ port: 70000 }).message,
      reject({ host: "" }).message,
      reject({ password: 5 }).message,
      reject({ folders: ["INBOX", "INBOX"] }).message,
      reject({ extra: 1 }).message,
    ];
    for (const message of messages) {
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("acme.example");
      expect(message).not.toContain("70000");
      expect(message).not.toContain("INBOX");
    }
  });
});
