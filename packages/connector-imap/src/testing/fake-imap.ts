import {
  ascii,
  headerBytes,
  joined,
  parseRanges,
  tokenize,
} from "./fake-wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeMessage {
  uid: number;
  internaldate: string;
  raw: Uint8Array;
}

export interface FakeFolder {
  wire: string;
  attributes: string[];
  uidvalidity: number;
  uidnext: number;
  messages: FakeMessage[];
}

export interface FakeImapOptions {
  username?: string;
  password?: string;
  /** Response code the server attaches when LOGIN is refused, e.g. `LIMIT`. */
  loginFailureCode?: string | null;
  preauth?: boolean;
  delimiter?: string;
  /** Names the fetched section `BODY[]<0>`, as some real servers do. */
  decorateBodySection?: boolean;
}

/**
 * An in-process IMAP4rev1 subset for tests. It rejects the mutating commands
 * outright so a connector that ever learned to send one would fail loudly.
 */
export class FakeImapServer {
  readonly received: string[] = [];
  readonly folders: FakeFolder[];
  private readonly options: Required<FakeImapOptions>;
  private buffer = new Uint8Array(0);
  private awaitingLiteral = 0;
  private partial = "";
  private authenticated: boolean;
  private selected: FakeFolder | null = null;
  private pendingDelayMs = 0;
  private pendingOversizedLiteral = false;
  private pendingBye = false;
  private readonly withheld = new Set<string>();

  constructor(folders: FakeFolder[], options: FakeImapOptions = {}) {
    this.folders = folders;
    this.options = {
      username: options.username ?? "ada@acme.example",
      password: options.password ?? "app-password",
      loginFailureCode: options.loginFailureCode ?? null,
      preauth: options.preauth ?? false,
      delimiter: options.delimiter ?? "/",
      decorateBodySection: options.decorateBodySection ?? false,
    };
    this.authenticated = this.options.preauth;
  }

  greeting(): Uint8Array {
    return ascii(
      this.options.preauth
        ? "* PREAUTH ready\r\n"
        : "* OK fake service ready\r\n",
    );
  }

  delayNext(ms: number): void {
    this.pendingDelayMs = ms;
  }

  oversizedLiteralNext(): void {
    this.pendingOversizedLiteral = true;
  }

  byeNext(): void {
    this.pendingBye = true;
  }

  takeDelay(): number {
    const delay = this.pendingDelayMs;
    this.pendingDelayMs = 0;
    return delay;
  }

  folder(wire: string): FakeFolder {
    const found = this.folders.find((entry) => entry.wire === wire);
    if (found === undefined) throw new Error(`no such fake folder: ${wire}`);
    return found;
  }

  expunge(wire: string, uid: number): void {
    const folder = this.folder(wire);
    folder.messages = folder.messages.filter((message) => message.uid !== uid);
  }

  append(
    wire: string,
    raw: string,
    internaldate = "01-Mar-2026 09:00:00 +0000",
  ): number {
    const folder = this.folder(wire);
    const uid = folder.uidnext;
    folder.uidnext += 1;
    folder.messages.push({ uid, internaldate, raw: encoder.encode(raw) });
    return uid;
  }

  /** Answers a body fetch for this UID with no body, the way a server does
   * when the message went away between the two fetches of one page. */
  withholdBody(wire: string, uid: number): void {
    this.withheld.add(`${wire}\u0001${uid}`);
  }

  /** Hands the body back, the way a server does once the fault clears. */
  restoreBody(wire: string, uid: number): void {
    this.withheld.delete(`${wire}\u0001${uid}`);
  }

  /** Re-numbers a mailbox the way a restored server does. */
  resetUidValidity(wire: string): void {
    const folder = this.folder(wire);
    folder.uidvalidity += 1;
    folder.messages = folder.messages.map((message, index) => ({
      ...message,
      uid: index + 1,
    }));
    folder.uidnext = folder.messages.length + 1;
  }

  feed(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    const responses: Uint8Array[] = [];

    for (;;) {
      if (this.awaitingLiteral > 0) {
        if (this.buffer.length < this.awaitingLiteral) break;
        const payload = this.buffer.slice(0, this.awaitingLiteral);
        this.buffer = this.buffer.slice(this.awaitingLiteral);
        this.awaitingLiteral = 0;
        const text = decoder.decode(payload);
        this.received.push(text);
        this.partial += `"${text.replace(/([\\"])/g, "\\$1")}"`;
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const end =
        newline > 0 && this.buffer[newline - 1] === 0x0d
          ? newline - 1
          : newline;
      const line = decoder.decode(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(newline + 1);
      this.received.push(line);

      const marker = /\{(\d+)\+?\}$/.exec(line);
      if (marker !== null) {
        this.partial += line.slice(0, line.length - (marker[0] ?? "").length);
        this.awaitingLiteral = Number(marker[1] ?? "0");
        responses.push(ascii("+ ready\r\n"));
        continue;
      }
      const command = this.partial + line;
      this.partial = "";
      responses.push(...this.dispatch(command));
    }
    return responses;
  }

  private dispatch(command: string): Uint8Array[] {
    if (this.pendingBye) {
      this.pendingBye = false;
      return [ascii("* BYE server going down\r\n")];
    }
    if (this.pendingOversizedLiteral) {
      this.pendingOversizedLiteral = false;
      return [ascii("* OK {9000000}\r\n")];
    }
    const args = tokenize(command);
    const tag = args[0] ?? "";
    const verb = (args[1] ?? "").toUpperCase();
    const rest = args.slice(2);

    switch (verb) {
      case "CAPABILITY":
        return [ascii("* CAPABILITY IMAP4rev1\r\n"), ascii(`${tag} OK done\r\n`)];
      case "LOGIN":
        return this.login(tag, rest);
      case "LIST":
        return this.list(tag);
      case "EXAMINE":
        return this.examine(tag, rest[0] ?? "");
      case "UID":
        return this.uid(tag, rest);
      case "NOOP":
        return [ascii(`${tag} OK done\r\n`)];
      case "LOGOUT":
        return [ascii("* BYE logging out\r\n"), ascii(`${tag} OK done\r\n`)];
      case "SELECT":
      case "STORE":
      case "EXPUNGE":
      case "APPEND":
        return [ascii(`${tag} NO read-only fake refuses ${verb}\r\n`)];
      default:
        return [ascii(`${tag} BAD unsupported\r\n`)];
    }
  }

  private login(tag: string, args: string[]): Uint8Array[] {
    const [username, password] = args;
    if (
      username === this.options.username &&
      password === this.options.password
    ) {
      this.authenticated = true;
      return [ascii(`${tag} OK signed in\r\n`)];
    }
    const code =
      this.options.loginFailureCode === null
        ? ""
        : `[${this.options.loginFailureCode}] `;
    return [ascii(`${tag} NO ${code}Invalid credentials\r\n`)];
  }

  private list(tag: string): Uint8Array[] {
    if (!this.authenticated) {
      return [ascii(`${tag} NO not authenticated\r\n`)];
    }
    const lines = this.folders.map((folder) =>
      ascii(
        `* LIST (${folder.attributes.join(" ")}) "${this.options.delimiter}" "${folder.wire}"\r\n`,
      ),
    );
    return [...lines, ascii(`${tag} OK done\r\n`)];
  }

  private examine(tag: string, wire: string): Uint8Array[] {
    if (!this.authenticated) {
      return [ascii(`${tag} NO not authenticated\r\n`)];
    }
    const folder = this.folders.find((entry) => entry.wire === wire);
    if (folder === undefined) {
      return [ascii(`${tag} NO [TRYCREATE] no such mailbox\r\n`)];
    }
    if (folder.attributes.some((flag) => flag.toLowerCase() === "\\noselect")) {
      return [ascii(`${tag} NO mailbox is not selectable\r\n`)];
    }
    this.selected = folder;
    return [
      ascii(`* ${folder.messages.length} EXISTS\r\n`),
      ascii(`* OK [UIDVALIDITY ${folder.uidvalidity}] validity\r\n`),
      ascii(`* OK [UIDNEXT ${folder.uidnext}] predicted\r\n`),
      ascii(`${tag} OK [READ-ONLY] examined\r\n`),
    ];
  }

  private uid(tag: string, args: string[]): Uint8Array[] {
    const verb = (args[0] ?? "").toUpperCase();
    const folder = this.selected;
    if (folder === null) return [ascii(`${tag} BAD no mailbox examined\r\n`)];
    if (verb === "SEARCH") return this.search(tag, folder, args.slice(1));
    if (verb !== "FETCH") {
      return [ascii(`${tag} BAD unsupported uid command\r\n`)];
    }

    const set = args[1] ?? "";
    const items = (args[2] ?? "").toUpperCase();
    const ranges = parseRanges(set, folder.uidnext);
    const selected = folder.messages
      .filter((message) =>
        ranges.some(
          (range) => message.uid >= range.first && message.uid <= range.last,
        ),
      )
      .sort((a, b) => a.uid - b.uid);

    const lines: Uint8Array[] = [];
    const decoration = this.options.decorateBodySection ? "<0>" : "";
    const literal = (
      sequence: number,
      uid: number,
      section: string,
      payload: Uint8Array,
    ): Uint8Array =>
      joined([
        ascii(
          `* ${sequence} FETCH (UID ${uid} BODY[${section}]${decoration} {${payload.length}}\r\n`,
        ),
        payload,
        ascii(")\r\n"),
      ]);
    selected.forEach((message, index) => {
      const sequence = index + 1;
      const bodyWanted =
        items.includes("BODY.PEEK[HEADER]") || items.includes("BODY.PEEK[]");
      if (bodyWanted && this.withheld.has(`${folder.wire}\u0001${message.uid}`)) {
        lines.push(ascii(`* ${sequence} FETCH (UID ${message.uid})\r\n`));
        return;
      }
      if (items.includes("BODY.PEEK[HEADER]")) {
        lines.push(
          literal(sequence, message.uid, "HEADER", headerBytes(message.raw)),
        );
        return;
      }
      if (items.includes("BODY.PEEK[]")) {
        lines.push(literal(sequence, message.uid, "", message.raw));
        return;
      }
      lines.push(
        ascii(
          `* ${sequence} FETCH (UID ${message.uid} INTERNALDATE "${message.internaldate}" RFC822.SIZE ${message.raw.length})\r\n`,
        ),
      );
    });
    return [...lines, ascii(`${tag} OK done\r\n`)];
  }

  private search(tag: string, folder: FakeFolder, args: string[]): Uint8Array[] {
    const needles = args
      .join(" ")
      .split(/\s+/)
      .filter((piece) => piece.includes("@"))
      .map((piece) => piece.replace(/"/g, "").toLowerCase());
    const matches = folder.messages.filter((message) => {
      const text = decoder.decode(message.raw).toLowerCase();
      return needles.some((needle) => text.includes(needle));
    });
    return [
      ascii(`* SEARCH ${matches.map((message) => message.uid).join(" ")}\r\n`),
      ascii(`${tag} OK done\r\n`),
    ];
  }
}
