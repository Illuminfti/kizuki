import type { CaptureEventInput } from "@kizuki/core";
import { messageEvent } from "./events";

export const FIXTURE_OBSERVED_AT = "2026-03-01T00:00:00.000Z";
export const FIXTURE_FOLDER_WIRE = "INBOX";
export const FIXTURE_FOLDER_DISPLAY = "INBOX";
export const FIXTURE_UIDVALIDITY = 42;

export interface FixtureMessage {
  uid: number;
  internaldate: string;
  raw: string;
  section: "" | "HEADER";
}

const crlf = (lines: string[]): string => lines.join("\r\n");

/**
 * Synthetic RFC 5322 messages that exercise every branch of the parser. They
 * are the connector's offline sample and the fake server's seed, so the
 * fixture and the wire path cannot drift apart.
 */
export const FIXTURE_MESSAGES: FixtureMessage[] = [
  {
    uid: 1,
    internaldate: "01-Mar-2026 08:00:00 +0000",
    section: "",
    raw: crlf([
      "From: Ada <ada@acme.example>",
      "To: Grace <grace@acme.example>",
      "Subject: Weekly sync",
      "Date: Sun, 01 Mar 2026 08:00:00 +0000",
      "Message-ID: <plain-1@acme.example>",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "Notes are in the shared folder.",
      "",
    ]),
  },
  {
    uid: 2,
    internaldate: "01-Mar-2026 08:05:00 +0000",
    section: "",
    raw: crlf([
      "From: Grace <grace@acme.example>",
      "To: ada@acme.example",
      "Cc: Linus <linus@example.org>",
      "Subject: Release notes",
      "Date: Sun, 01 Mar 2026 08:05:00 +0000",
      "Message-ID: <html-1@acme.example>",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Shipped</p><p>Tagged</p></body></html>",
      "",
    ]),
  },
  {
    uid: 3,
    internaldate: "01-Mar-2026 08:10:00 +0000",
    section: "",
    raw: crlf([
      "From: Ada <ada@acme.example>",
      "To: team@acme.example",
      "Subject: Both flavours",
      "Date: Sun, 01 Mar 2026 08:10:00 +0000",
      "Message-ID: <alt-1@acme.example>",
      "List-Id: Team list <team.acme.example>",
      "Content-Type: multipart/alternative; boundary=ALT",
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain wins.",
      "--ALT",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML loses.</p>",
      "--ALT--",
      "",
    ]),
  },
  {
    uid: 4,
    internaldate: "01-Mar-2026 08:15:00 +0000",
    section: "",
    raw: crlf([
      "From: Linus <linus@example.org>",
      "To: ada@acme.example",
      "Subject: Celebration",
      "Date: Sun, 01 Mar 2026 08:15:00 +0000",
      "Message-ID: <b64-1@example.org>",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "V2Ugc2hpcHBlZCEg8J+Ygg==",
      "",
    ]),
  },
  {
    uid: 5,
    internaldate: "01-Mar-2026 08:20:00 +0000",
    section: "",
    raw: crlf([
      "From: Grace <grace@acme.example>",
      "To: ada@acme.example",
      "Subject: Cafe notes",
      "Date: Sun, 01 Mar 2026 08:20:00 +0000",
      "Message-ID: <qp-1@acme.example>",
      "Content-Type: text/plain; charset=windows-1252",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Met at the caf=E9 on the corner.",
      "",
    ]),
  },
  {
    uid: 6,
    internaldate: "01-Mar-2026 08:25:00 +0000",
    section: "",
    raw: crlf([
      "From: =?utf-8?B?w4RkYSBM?= <ada@acme.example>",
      "To: grace@acme.example",
      "Subject: =?utf-8?B?Q2Fmw6k=?= =?windows-1252?Q?_r=E9sum=E9?=",
      "Date: Sun, 01 Mar 2026 08:25:00 +0000",
      "Message-ID: <words-1@acme.example>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Encoded words above.",
      "",
    ]),
  },
  {
    uid: 7,
    internaldate: "01-Mar-2026 08:30:00 +0000",
    section: "",
    raw: crlf([
      "From: Grace <grace@acme.example>",
      "To: Ada <ada@acme.example>",
      "Subject: Re: Weekly sync",
      "Date: Sun, 01 Mar 2026 08:30:00 +0000",
      "Message-ID: <reply-1@acme.example>",
      "In-Reply-To: <plain-1@acme.example>",
      "References: <plain-1@acme.example> <alt-1@acme.example>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Reading them now.",
      "",
    ]),
  },
  {
    uid: 8,
    internaldate: "01-Mar-2026 08:35:00 +0000",
    section: "",
    raw: crlf([
      "From: Ada <ada@acme.example>",
      "To: linus@example.org",
      "Subject: Quarterly report",
      "Date: Sun, 01 Mar 2026 08:35:00 +0000",
      "Message-ID: <attach-1@acme.example>",
      "Content-Type: multipart/mixed; boundary=MIX",
      "",
      "--MIX",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Attached.",
      "--MIX",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename*0*=utf-8''caf%C3%A9%20; filename*1*=report.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--MIX--",
      "",
    ]),
  },
  {
    uid: 9,
    internaldate: "01-Mar-2026 08:40:00 +0000",
    section: "",
    raw: crlf([
      "From: Linus <linus@example.org>",
      "To: ada@acme.example",
      "Subject: Logo draft",
      "Date: Sun, 01 Mar 2026 08:40:00 +0000",
      "Message-ID: <inline-1@example.org>",
      "Content-Type: multipart/related; boundary=REL",
      "",
      "--REL",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See the mark below.",
      "--REL",
      "Content-Type: image/png; name=mark.png",
      "Content-ID: <mark@example.org>",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--REL--",
      "",
    ]),
  },
  {
    uid: 10,
    internaldate: "01-Mar-2026 08:45:00 +0000",
    section: "",
    raw: crlf([
      "From: Grace <grace@acme.example>",
      "To: ada@acme.example",
      "Subject: Legacy encoding",
      "Date: Sun, 01 Mar 2026 08:45:00 +0000",
      "Message-ID: <charset-1@acme.example>",
      "Content-Type: text/plain; charset=iso-8859-2",
      "",
      "Legacy bytes here.",
      "",
    ]),
  },
  {
    uid: 11,
    internaldate: "01-Mar-2026 08:50:00 +0000",
    section: "HEADER",
    raw: crlf([
      "From: Ada <ada@acme.example>",
      "To: grace@acme.example",
      "Subject: Very large export",
      "Date: Sun, 01 Mar 2026 08:50:00 +0000",
      "Message-ID: <big-1@acme.example>",
      "Content-Type: application/zip; name=export.zip",
      "",
    ]),
  },
  {
    uid: 12,
    internaldate: "01-Mar-2026 08:55:00 +0000",
    section: "",
    raw: crlf([
      "From: Linus <linus@example.org>",
      "To: ada@acme.example",
      "Subject: Clock trouble",
      "Date: not a date at all",
      "Message-ID: <baddate-1@example.org>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "My mail client has opinions.",
      "",
    ]),
  },
  {
    uid: 13,
    internaldate: "01-Mar-2026 09:00:00 +0000",
    section: "",
    raw: crlf([
      "From: Ada <ada@acme.example>",
      "To: grace@acme.example",
      "Subject: Dated with a comment",
      "Date: Sun, 01 Mar 2026 09:00:00 +0000 (UTC)",
      "Message-ID: <comment-1@acme.example>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The zone is spelled out in a comment.",
      "",
    ]),
  },
];

export function fixtureEvents(): CaptureEventInput[] {
  const encoder = new TextEncoder();
  return FIXTURE_MESSAGES.map((message) => {
    const raw = encoder.encode(message.raw);
    return messageEvent({
      folderWire: FIXTURE_FOLDER_WIRE,
      folderDisplay: FIXTURE_FOLDER_DISPLAY,
      uidvalidity: FIXTURE_UIDVALIDITY,
      uid: message.uid,
      internaldate: message.internaldate,
      size: raw.byteLength,
      raw,
      section: message.section,
      observedAt: FIXTURE_OBSERVED_AT,
    });
  });
}
