import { DEFAULT_MAX_MESSAGE_BYTES } from "../state";
import type { ImapState } from "../state";
import {
  FIXTURE_FOLDER_WIRE,
  FIXTURE_MESSAGES,
  FIXTURE_UIDVALIDITY,
  fixtureBytes,
} from "../fixture";
import { FakeImapServer } from "./fake-imap";
import type { FakeFolder } from "./fake-imap";

export { FakeImapServer } from "./fake-imap";
export type { FakeFolder, FakeImapOptions, FakeMessage } from "./fake-imap";
export { memoryDialer } from "./memory-dialer";

export const FIXTURE_HOST = "mail.acme.example";
export const FIXTURE_USERNAME = "ada@acme.example";
export const FIXTURE_PASSWORD = 'pw-with-quote"-and-ünïcode';
export const FIXTURE_ARCHIVE_WIRE = "Archive/2026";

export function fixtureState(overrides: Partial<ImapState> = {}): ImapState {
  return {
    schema: "kizuki.imap-state/v1",
    host: FIXTURE_HOST,
    port: 993,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    folders: [FIXTURE_FOLDER_WIRE],
    max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
    ...overrides,
  };
}

/** The fixture messages as a seeded mailbox for `FakeImapServer`. */
export function fixtureMailbox(): FakeFolder[] {
  const encoder = new TextEncoder();
  return [
    {
      wire: FIXTURE_FOLDER_WIRE,
      attributes: ["\\HasNoChildren"],
      uidvalidity: FIXTURE_UIDVALIDITY,
      uidnext: FIXTURE_MESSAGES.length + 1,
      messages: FIXTURE_MESSAGES.map((message) => ({
        uid: message.uid,
        internaldate: message.internaldate,
        raw: fixtureBytes(message),
      })),
    },
    {
      wire: FIXTURE_ARCHIVE_WIRE,
      attributes: ["\\HasNoChildren"],
      uidvalidity: 9,
      uidnext: 2,
      messages: [
        {
          uid: 1,
          internaldate: "01-Feb-2026 12:00:00 +0000",
          raw: encoder.encode(
            [
              "From: Grace <grace@acme.example>",
              "To: ada@acme.example",
              "Subject: Filed away",
              "Date: Sun, 01 Feb 2026 12:00:00 +0000",
              "Message-ID: <archive-1@acme.example>",
              "Content-Type: text/plain; charset=utf-8",
              "",
              "Kept for the record.",
              "",
            ].join("\r\n"),
          ),
        },
      ],
    },
    {
      wire: "&AOk-quipe",
      attributes: ["\\Noselect"],
      uidvalidity: 3,
      uidnext: 1,
      messages: [],
    },
  ];
}

export function fixtureServer(): FakeImapServer {
  return new FakeImapServer(fixtureMailbox(), {
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
  });
}
