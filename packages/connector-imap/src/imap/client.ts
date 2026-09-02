import { KizukiError } from "@kizuki/core";
import type { ImapConn } from "../transport";
import { failureFor } from "./codes";
import { ResponseReader } from "./tokenizer";
import type { ImapResponse } from "./tokenizer";

export const COMMAND_TIMEOUT_MS = 60_000;
/**
 * Above the largest legitimate reply: a 1000-UID FETCH window answers with one
 * untagged line per message, plus a handful of status lines.
 */
export const MAX_UNTAGGED = 5_000;

export type CommandArg =
  | { kind: "atom"; value: string }
  | { kind: "string"; value: string };

export const atom = (value: string): CommandArg => ({ kind: "atom", value });
export const str = (value: string): CommandArg => ({ kind: "string", value });

export interface CommandResult {
  untagged: ImapResponse[];
  tagged: ImapResponse;
}

export interface ClientOptions {
  commandTimeoutMs?: number;
}

type Piece = { text: string } | { literal: Uint8Array };

const encoder = new TextEncoder();

function needsLiteral(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0d || code === 0x0a || code > 0x7e) return true;
  }
  return false;
}

function quote(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/**
 * One command at a time over one connection. Nothing here logs: a trace of a
 * command line would carry the owner's app password.
 */
export class ImapClient {
  private readonly reader: ResponseReader;
  private readonly timeoutMs: number;
  private counter = 0;
  private closed = false;

  constructor(
    private readonly conn: ImapConn,
    options: ClientOptions = {},
  ) {
    this.reader = new ResponseReader(conn);
    this.timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  /**
   * `deadline` is the whole command's budget, not one response's: a server that
   * trickles an untagged line under the timeout would otherwise hold a command
   * open for as long as it liked.
   */
  private async read(deadline: number): Promise<ImapResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          this.close();
          reject(new KizukiError("unreachable", "command timed out"));
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const response = await Promise.race([this.reader.next(), timeout]);
      if (response === null) {
        this.close();
        throw new KizukiError("unreachable", "server closed the connection");
      }
      if (response.tag === "*" && /^BYE\b/i.test(response.text)) {
        this.close();
        throw new KizukiError("unreachable", "server said BYE");
      }
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The server's opening line; a `* BYE` greeting surfaces as unreachable. */
  async greeting(): Promise<ImapResponse> {
    return this.read(Date.now() + this.timeoutMs);
  }

  private buildPieces(command: string, args: CommandArg[], tag: string): Piece[] {
    const pieces: Piece[] = [];
    let text = `${tag} ${command}`;
    for (const arg of args) {
      if (arg.value.includes("\0")) {
        throw new KizukiError(
          "misconfigured",
          "kizuki.imap: a command argument contains a NUL byte",
        );
      }
      if (arg.kind === "atom") {
        text += ` ${arg.value}`;
        continue;
      }
      if (!needsLiteral(arg.value)) {
        text += ` ${quote(arg.value)}`;
        continue;
      }
      const literal = encoder.encode(arg.value);
      pieces.push({ text: `${text} {${literal.length}}` });
      pieces.push({ literal });
      text = "";
    }
    pieces.push({ text });
    return pieces;
  }

  async send(
    command: string,
    args: CommandArg[] = [],
    options: { login?: boolean } = {},
  ): Promise<CommandResult> {
    this.counter += 1;
    const tag = `A${String(this.counter).padStart(4, "0")}`;
    const pieces = this.buildPieces(command, args, tag);
    const deadline = Date.now() + this.timeoutMs;

    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece === undefined) continue;
      if ("literal" in piece) {
        await this.conn.send(piece.literal);
        continue;
      }
      await this.conn.send(asciiBytes(`${piece.text}\r\n`));
      if (index + 1 < pieces.length) {
        const continuation = await this.read(deadline);
        if (continuation.tag !== "+") {
          throw failureFor(continuation.text, { login: options.login === true });
        }
      }
    }

    const untagged: ImapResponse[] = [];
    for (;;) {
      const response = await this.read(deadline);
      if (response.tag !== tag) {
        if (untagged.length >= MAX_UNTAGGED) {
          this.close();
          throw new KizukiError("protocol", "too many untagged responses");
        }
        untagged.push(response);
        continue;
      }
      const status = (response.text.split(/\s+/)[0] ?? "").toUpperCase();
      if (status === "OK") return { untagged, tagged: response };
      const rest = response.text.slice(status.length).trim();
      throw failureFor(rest, { login: options.login === true });
    }
  }
}
