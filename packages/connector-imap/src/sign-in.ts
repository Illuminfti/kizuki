import { KizukiError } from "@kizuki/core";
import type {
  ConnectionStateWriter,
  SignInDisplay,
  SignInIo,
} from "@kizuki/core";
import { ImapSession } from "./imap/session";
import type { MailboxEntry, SessionOptions } from "./imap/session";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  serializeImapState,
  validateHost,
  validatePort,
} from "./state";
import type { ImapState } from "./state";
import type { ImapDialer } from "./transport";

export const DEFAULT_PORT = 993;
export const MAX_LISTED_FOLDERS = 40;

export interface SignInDeps {
  dial: ImapDialer;
  session?: SessionOptions;
}

function folderSummary(entries: MailboxEntry[]): string {
  const names = entries.map((entry) => entry.display);
  const shown = names.slice(0, MAX_LISTED_FOLDERS).join(", ");
  const extra = names.length - MAX_LISTED_FOLDERS;
  return extra > 0 ? `${shown}, +${extra} more` : shown;
}

function matches(entry: MailboxEntry, wanted: string): boolean {
  // RFC 3501: INBOX is the one mailbox name that is case-insensitive.
  if (wanted.toUpperCase() === "INBOX") {
    return entry.display.toUpperCase() === "INBOX";
  }
  return entry.display === wanted;
}

/**
 * The owner types four answers and picks folders; everything typed lands in
 * the host's opaque state file and nowhere else. A failure at any step writes
 * nothing, so a half-configured connection cannot exist.
 */
export async function signInImap(
  io: SignInIo,
  writer: ConnectionStateWriter,
  deps: SignInDeps,
): Promise<SignInDisplay> {
  const host = (await io.prompt("IMAP server host: ")).trim();
  validateHost(host);
  const rawPort = (await io.prompt("IMAP port [993]: ")).trim();
  const port =
    rawPort.length === 0
      ? DEFAULT_PORT
      : validatePort(/^\d+$/.test(rawPort) ? Number(rawPort) : rawPort);
  const username = (
    await io.prompt("Username (usually your email address): ")
  ).trim();
  const password = await io.prompt("App password: ", { secret: true });
  if (username.length === 0 || password.length === 0) {
    throw new KizukiError(
      "misconfigured",
      "kizuki.imap: username and app password are required",
    );
  }

  const probe: ImapState = {
    schema: "kizuki.imap-state/v1",
    host,
    port,
    username,
    password,
    folders: ["INBOX"],
    max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
  };

  const session = await ImapSession.open(deps.dial, probe, deps.session ?? {});
  let folders: string[];
  try {
    const entries = await session.list();
    io.notify(`Folders on the server: ${folderSummary(entries)}`);
    const answer = (await io.prompt("Folders to sync [INBOX]: ")).trim();
    const wanted =
      answer.length === 0
        ? ["INBOX"]
        : answer
            .split(",")
            .map((piece) => piece.trim())
            .filter((piece) => piece.length > 0);

    // INBOX is not one of the choices; it is the floor the choices add to,
    // so it is seeded first and the owner's picks follow it.
    const inbox = entries.find((candidate) => matches(candidate, "INBOX"));
    if (inbox === undefined) {
      throw new KizukiError(
        "misconfigured",
        "kizuki.imap: the server lists no INBOX",
      );
    }
    const unknown: string[] = [];
    const wire: string[] = [inbox.wire];
    for (const name of wanted) {
      const entry = entries.find((candidate) => matches(candidate, name));
      if (entry === undefined) {
        unknown.push(name);
        continue;
      }
      if (!wire.includes(entry.wire)) wire.push(entry.wire);
    }
    if (unknown.length > 0) {
      throw new KizukiError(
        "misconfigured",
        `kizuki.imap: unknown folders: ${unknown.join(", ")}`,
      );
    }

    for (const name of wire) await session.examine(name);
    folders = wire;
    await session.logout();
  } catch (error) {
    session.close();
    throw error;
  }

  await writer.write(serializeImapState({ ...probe, folders }));
  return { display: username };
}
