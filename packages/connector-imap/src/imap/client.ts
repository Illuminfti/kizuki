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
  /**
   * Strings the server must never be able to quote back into an error. The
   * session passes the account name and the app password.
   */
  secrets?: readonly string[];
}

type Piece = { text: string } | { literal: Uint8Array };

const encoder = new TextEncoder();

/**
 * A command line carries printable US-ASCII and nothing else. Everything
 * outside that range travels as a literal, whose length the server reads
 * before the bytes, so no value can ever end a line the caller did not end.
 */
function fitsOnTheLine(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function quote(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * The last gate before the socket. Masking a code unit into a byte would let a
 * character whose low byte is CR, LF or SPACE split one command into two.
 */
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7e || (code < 0x20 && code !== 0x0d && code !== 0x0a)) {
      throw new KizukiError(
        "protocol",
        "kizuki.imap: refusing to send a command line that is not ASCII",
      );
    }
    bytes[index] = code;
  }
  return bytes;
}

/** Drops the leading status word so the response code is the head of the text. */
function refusal(
  response: ImapResponse,
  options: { login?: boolean },
  secrets: readonly string[],
): KizukiError {
  const status = response.text.split(/\s+/)[0] ?? "";
  return failureFor(response.text.slice(status.length).trim(), {
    login: options.login === true,
    secrets,
  });
}

/**
 * One command at a time over one connection. Nothing here logs: a trace of a
 * command line would carry the owner's app password.
 */
export class ImapClient {
  private readonly reader: ResponseReader;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private counter = 0;
  private closed = false;

  constructor(
    private readonly conn: ImapConn,
    options: ClientOptions = {},
  ) {
    this.reader = new ResponseReader(conn);
    this.timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.secrets = options.secrets ?? [];
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
        // An atom is spliced into the line verbatim, so it has no escape hatch:
        // anything the line cannot hold has to be refused, not folded down.
        if (!fitsOnTheLine(arg.value)) {
          throw new KizukiError(
            "misconfigured",
            "kizuki.imap: a command argument is not printable ASCII",
          );
        }
        text += ` ${arg.value}`;
        continue;
      }
      if (fitsOnTheLine(arg.value)) {
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

  /**
   * RFC 3501 section 7 lets a server send an untagged response at any point, so
   * a status line arriving before the `+` is chatter to collect, not a refusal.
   */
  private async awaitContinuation(
    deadline: number,
    untagged: ImapResponse[],
    options: { login?: boolean },
  ): Promise<void> {
    for (;;) {
      const response = await this.read(deadline);
      if (response.tag === "+") return;
      if (response.tag !== "*") throw refusal(response, options, this.secrets);
      this.collect(untagged, response);
    }
  }

  private collect(untagged: ImapResponse[], response: ImapResponse): void {
    if (untagged.length >= MAX_UNTAGGED) {
      this.close();
      throw new KizukiError("protocol", "too many untagged responses");
    }
    untagged.push(response);
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
    const untagged: ImapResponse[] = [];

    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece === undefined) continue;
      if ("literal" in piece) {
        await this.conn.send(piece.literal);
        continue;
      }
      await this.conn.send(asciiBytes(`${piece.text}\r\n`));
      if (index + 1 < pieces.length) {
        await this.awaitContinuation(deadline, untagged, options);
      }
    }

    for (;;) {
      const response = await this.read(deadline);
      if (response.tag !== tag) {
        this.collect(untagged, response);
        continue;
      }
      if (/^OK\b/i.test(response.text)) return { untagged, tagged: response };
      throw refusal(response, options, this.secrets);
    }
  }
}
