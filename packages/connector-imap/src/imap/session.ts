import { KizukiError } from "@kizuki/core";
import type { ImapDialer, DialOptions } from "../transport";
import type { ImapState } from "../state";
import { ImapClient, atom, str } from "./client";
import type { ClientOptions } from "./client";
import { tokenText } from "./tokenizer";
import type { ImapResponse, Token } from "./tokenizer";
import { folderLabel } from "../events";

export const MAX_BODY_FETCH = 20;

export interface MailboxEntry {
  /** Server-side name, used verbatim in commands. */
  wire: string;
  /** Modified-UTF-7 decoded name, shown to the owner. */
  display: string;
  delimiter: string | null;
  attributes: string[];
}

export interface MailboxStatus {
  uidvalidity: number;
  uidnext: number;
}

export interface MessageSummary {
  uid: number;
  internaldate: string;
  size: number;
}

export interface SessionOptions extends ClientOptions {
  dialTimeoutMs?: number;
  ca?: string;
}

function protocolError(detail: string): KizukiError {
  return new KizukiError("protocol", detail);
}

function fetchFields(items: Token[]): Map<string, Token> {
  const fields = new Map<string, Token>();
  for (let index = 0; index + 1 < items.length; index += 2) {
    const key = tokenText(items[index]).toUpperCase();
    const value = items[index + 1];
    if (value !== undefined) fields.set(key, value);
  }
  return fields;
}

/**
 * A server may answer `BODY[]` with an origin suffix such as `BODY[]<0>`, so
 * the section is matched rather than compared: an exact-key lookup would drop
 * every message of such a server without a word.
 */
function bodyField(
  fields: Map<string, Token>,
  section: "" | "HEADER",
): Token | undefined {
  const wanted = `BODY[${section}]`;
  for (const [key, value] of fields) {
    if (key === wanted || key.startsWith(`${wanted}<`)) return value;
  }
  return undefined;
}

function fetchLists(responses: ImapResponse[]): Token[][] {
  const lists: Token[][] = [];
  for (const response of responses) {
    if (response.tag !== "*") continue;
    if (tokenText(response.items[1]).toUpperCase() !== "FETCH") continue;
    const payload = response.items[2];
    if (payload?.kind === "list") lists.push(payload.items);
  }
  return lists;
}

function codeNumber(responses: ImapResponse[], name: string): number | null {
  for (const response of responses) {
    const match = new RegExp(`\\[${name}\\s+(\\d+)\\]`, "i").exec(
      response.text,
    );
    if (match !== null) return Number(match[1] ?? "0");
  }
  return null;
}

function integer(token: Token | undefined, what: string): number {
  const value = Number(tokenText(token));
  if (!Number.isInteger(value) || value < 0) {
    throw protocolError(`server sent a malformed ${what}`);
  }
  return value;
}

/**
 * A read-only IMAP4rev1 session. The command surface is deliberately tiny:
 * EXAMINE rather than SELECT and BODY.PEEK rather than BODY, so syncing a
 * mailbox can never change what the owner sees in their mail client.
 */
export class ImapSession {
  private constructor(private readonly client: ImapClient) {}

  static async open(
    dial: ImapDialer,
    state: ImapState,
    options: SessionOptions = {},
  ): Promise<ImapSession> {
    const dialOptions: DialOptions = {
      timeoutMs: options.dialTimeoutMs ?? 15_000,
      ...(options.ca !== undefined ? { ca: options.ca } : {}),
    };
    const conn = await dial(state.host, state.port, dialOptions);
    const client = new ImapClient(
      conn,
      options.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: options.commandTimeoutMs }
        : {},
    );
    const greeting = await client.greeting();
    const status = (greeting.text.split(/\s+/)[0] ?? "").toUpperCase();
    if (status !== "OK" && status !== "PREAUTH") {
      client.close();
      throw new KizukiError("unreachable", "server refused the connection");
    }
    const session = new ImapSession(client);
    try {
      await client.send("CAPABILITY");
      if (status !== "PREAUTH") {
        await client.send("LOGIN", [str(state.username), str(state.password)], {
          login: true,
        });
      }
    } catch (error) {
      client.close();
      throw error;
    }
    return session;
  }

  async list(): Promise<MailboxEntry[]> {
    const result = await this.client.send("LIST", [str(""), str("*")]);
    const entries: MailboxEntry[] = [];
    for (const response of result.untagged) {
      if (tokenText(response.items[0]).toUpperCase() !== "LIST") continue;
      const attributeToken = response.items[1];
      const attributes =
        attributeToken?.kind === "list"
          ? attributeToken.items.map((item) => tokenText(item))
          : [];
      if (attributes.some((flag) => flag.toLowerCase() === "\\noselect")) {
        continue;
      }
      const delimiterToken = response.items[2];
      const wire = tokenText(response.items[3]);
      if (wire.length === 0) continue;
      entries.push({
        wire,
        display: folderLabel(wire),
        delimiter:
          delimiterToken?.kind === "nil" ? null : tokenText(delimiterToken),
        attributes,
      });
    }
    return entries;
  }

  async examine(folder: string): Promise<MailboxStatus> {
    const result = await this.client.send("EXAMINE", [str(folder)]);
    const uidvalidity = codeNumber(
      [...result.untagged, result.tagged],
      "UIDVALIDITY",
    );
    const uidnext = codeNumber([...result.untagged, result.tagged], "UIDNEXT");
    if (uidvalidity === null || uidnext === null) {
      throw protocolError("mailbox did not report UIDVALIDITY and UIDNEXT");
    }
    return { uidvalidity, uidnext };
  }

  async fetchSummaries(set: string): Promise<MessageSummary[]> {
    if (set.length === 0) return [];
    const result = await this.client.send("UID FETCH", [
      atom(set),
      atom("(UID INTERNALDATE RFC822.SIZE)"),
    ]);
    const summaries: MessageSummary[] = [];
    for (const items of fetchLists(result.untagged)) {
      const fields = fetchFields(items);
      const uidToken = fields.get("UID");
      if (uidToken === undefined) continue;
      summaries.push({
        uid: integer(uidToken, "uid"),
        internaldate: tokenText(fields.get("INTERNALDATE")),
        size: integer(fields.get("RFC822.SIZE"), "size"),
      });
    }
    return summaries.sort((a, b) => a.uid - b.uid);
  }

  async fetchBodies(
    uids: number[],
    section: "" | "HEADER",
  ): Promise<Map<number, Uint8Array>> {
    const bodies = new Map<number, Uint8Array>();
    if (uids.length === 0) return bodies;
    if (uids.length > MAX_BODY_FETCH) {
      throw protocolError("body fetch exceeds the per-command bound");
    }
    const result = await this.client.send("UID FETCH", [
      atom(uids.join(",")),
      atom(`(BODY.PEEK[${section}])`),
    ]);
    for (const items of fetchLists(result.untagged)) {
      const fields = fetchFields(items);
      const uidToken = fields.get("UID");
      if (uidToken === undefined) continue;
      const body = bodyField(fields, section);
      if (body === undefined) continue;
      bodies.set(
        integer(uidToken, "uid"),
        body.kind === "literal"
          ? body.bytes
          : new TextEncoder().encode(tokenText(body)),
      );
    }
    return bodies;
  }

  async search(criteria: string): Promise<number[]> {
    const result = await this.client.send("UID SEARCH", [atom(criteria)]);
    const uids: number[] = [];
    for (const response of result.untagged) {
      if (tokenText(response.items[0]).toUpperCase() !== "SEARCH") continue;
      for (const item of response.items.slice(1)) {
        const value = Number(tokenText(item));
        if (Number.isInteger(value) && value > 0) uids.push(value);
      }
    }
    return uids;
  }

  async logout(): Promise<void> {
    try {
      await this.client.send("LOGOUT");
    } catch {
      // A server that drops the connection on LOGOUT has already given us
      // everything we asked for; the walk's result must not depend on it.
    } finally {
      this.client.close();
    }
  }

  close(): void {
    this.client.close();
  }
}
