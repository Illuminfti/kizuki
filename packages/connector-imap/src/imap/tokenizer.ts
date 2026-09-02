import { KizukiError } from "@kizuki/core";
import type { ImapConn } from "../transport";

export const MAX_LINE_BYTES = 65_536;
export const MAX_LITERAL_BYTES = 8_388_608;

export type Token =
  | { kind: "atom"; value: string }
  | { kind: "quoted"; value: string }
  | { kind: "literal"; bytes: Uint8Array }
  | { kind: "list"; items: Token[] }
  | { kind: "nil" };

export interface ImapResponse {
  /** `*` for untagged, `+` for a continuation, otherwise the command tag. */
  tag: string;
  /** The line after the tag, with `{n}` left in place of each literal. */
  text: string;
  items: Token[];
}

const LITERAL_MARKER = /\{(\d+)\+?\}$/;

function protocolError(detail: string): KizukiError {
  return new KizukiError("protocol", detail);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** Reads whole IMAP responses off a byte stream, literals included. */
export class ResponseReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private ended = false;

  constructor(
    private readonly conn: ImapConn,
    private readonly maxLineBytes: number = MAX_LINE_BYTES,
    private readonly maxLiteralBytes: number = MAX_LITERAL_BYTES,
  ) {}

  private async pull(): Promise<boolean> {
    const chunk = await this.conn.receive();
    if (chunk === null) {
      this.ended = true;
      return false;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  private async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > this.maxLineBytes) {
          this.conn.close();
          throw protocolError("response line exceeds bound");
        }
        const end = newline > 0 && this.buffer[newline - 1] === 0x0d ? newline - 1 : newline;
        const line = latin1(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.buffer.length > this.maxLineBytes) {
        this.conn.close();
        throw protocolError("response line exceeds bound");
      }
      if (!(await this.pull())) {
        return this.buffer.length === 0 ? null : latin1(this.buffer);
      }
    }
  }

  private async readExact(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) {
      if (!(await this.pull())) {
        throw protocolError("connection ended inside a literal");
      }
    }
    const bytes = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return bytes;
  }

  /** Resolves the next complete response, or null once the peer is done. */
  async next(): Promise<ImapResponse | null> {
    let segment = await this.readLine();
    if (segment === null) return null;
    const literals: Uint8Array[] = [];
    let line = "";

    // Only the freshly read segment can announce a literal; the markers
    // already folded into `line` stay put as placeholders for the scanner.
    for (;;) {
      const marker = LITERAL_MARKER.exec(segment);
      line += segment;
      if (marker === null) break;
      const size = Number(marker[1] ?? "0");
      if (size > this.maxLiteralBytes) {
        this.conn.close();
        throw protocolError("literal exceeds bound");
      }
      literals.push(await this.readExact(size));
      const continuation = await this.readLine();
      if (continuation === null) {
        throw protocolError("connection ended after a literal");
      }
      segment = continuation;
    }

    if (this.ended && line.length === 0) return null;
    return parseResponse(line, literals);
  }
}

interface Scanner {
  text: string;
  index: number;
  literals: Uint8Array[];
  literalIndex: number;
}

function skipSpaces(scanner: Scanner): void {
  while (scanner.text[scanner.index] === " ") scanner.index += 1;
}

function readQuoted(scanner: Scanner): Token {
  scanner.index += 1;
  let value = "";
  while (scanner.index < scanner.text.length) {
    const character = scanner.text[scanner.index] ?? "";
    if (character === "\\") {
      value += scanner.text[scanner.index + 1] ?? "";
      scanner.index += 2;
      continue;
    }
    if (character === '"') {
      scanner.index += 1;
      return { kind: "quoted", value };
    }
    value += character;
    scanner.index += 1;
  }
  throw protocolError("unterminated quoted string");
}

function readAtom(scanner: Scanner): Token {
  let value = "";
  let brackets = 0;
  while (scanner.index < scanner.text.length) {
    const character = scanner.text[scanner.index] ?? "";
    if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (brackets === 0 && (character === " " || character === ")")) break;
    value += character;
    scanner.index += 1;
  }
  if (value.toUpperCase() === "NIL") return { kind: "nil" };
  return { kind: "atom", value };
}

function readToken(scanner: Scanner): Token | null {
  skipSpaces(scanner);
  if (scanner.index >= scanner.text.length) return null;
  const character = scanner.text[scanner.index] ?? "";
  if (character === ")") return null;
  if (character === "(") {
    scanner.index += 1;
    const items: Token[] = [];
    for (;;) {
      skipSpaces(scanner);
      if (scanner.text[scanner.index] === ")") {
        scanner.index += 1;
        break;
      }
      const token = readToken(scanner);
      if (token === null) throw protocolError("unterminated list");
      items.push(token);
    }
    return { kind: "list", items };
  }
  if (character === '"') return readQuoted(scanner);
  if (character === "{") {
    const marker = /^\{(\d+)\+?\}/.exec(scanner.text.slice(scanner.index));
    if (marker !== null) {
      scanner.index += (marker[0] ?? "").length;
      const bytes = scanner.literals[scanner.literalIndex];
      scanner.literalIndex += 1;
      return { kind: "literal", bytes: bytes ?? new Uint8Array() };
    }
  }
  return readAtom(scanner);
}

export function parseResponse(line: string, literals: Uint8Array[]): ImapResponse {
  const scanner: Scanner = { text: line, index: 0, literals, literalIndex: 0 };
  const first = readToken(scanner);
  if (first === null) return { tag: "", text: "", items: [] };
  const tag =
    first.kind === "atom" || first.kind === "quoted" ? first.value : "";
  const text = line.slice(scanner.index).replace(/^\s+/, "");
  const items: Token[] = [];
  for (;;) {
    const token = readToken(scanner);
    if (token === null) break;
    items.push(token);
  }
  return { tag, text, items };
}

export function tokenText(token: Token | undefined): string {
  if (token === undefined) return "";
  if (token.kind === "atom" || token.kind === "quoted") return token.value;
  if (token.kind === "literal") return latin1(token.bytes);
  return "";
}
