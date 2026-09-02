import { describe, expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import {
  MAX_TEXT_CODE_POINTS,
  messageEvent,
  parseInternalDate,
  recordId,
  tombstoneEvent,
} from "../src/events";
import { fixtureEvents } from "../src/fixture";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function byId(): Map<string, CaptureEventInput> {
  return new Map(
    fixtureEvents().map((event) => [event.source_record_id, event]),
  );
}

function build(raw: string, section: "" | "HEADER" = ""): CaptureEventInput {
  const bytes = encode(raw);
  return messageEvent({
    folderWire: "Archive/2026",
    folderDisplay: "Archive/2026",
    uidvalidity: 9,
    uid: 4,
    internaldate: "01-Mar-2026 10:00:00 +0000",
    size: bytes.byteLength,
    raw: bytes,
    section,
    observedAt: "2026-03-02T00:00:00.000Z",
  });
}

describe("record ids and dates", () => {
  test("puts the numeric fields first so the split is unambiguous", () => {
    expect(recordId("Weird:Name", 9, 4)).toBe("9:4:Weird:Name");
  });

  test("parses INTERNALDATE with and without a zone", () => {
    expect(parseInternalDate("01-Jan-2026 10:00:00 +0000")).toBe(
      "2026-01-01T10:00:00.000Z",
    );
    expect(parseInternalDate("01-Jan-2026 10:00:00 +0200")).toBe(
      "2026-01-01T08:00:00.000Z",
    );
    expect(parseInternalDate("31-Dec-2025 23:30:00 -0500")).toBe(
      "2026-01-01T04:30:00.000Z",
    );
    expect(parseInternalDate("nonsense")).toBeNull();
    expect(parseInternalDate("01-Xyz-2026 10:00:00 +0000")).toBeNull();
  });
});

describe("the fixture messages map to exact events", () => {
  test("every fixture event validates and is an email", () => {
    const events = fixtureEvents();
    expect(events.length).toBeGreaterThanOrEqual(12);
    for (const event of events) {
      const validated = validateEventInput(event);
      expect(validated.ok).toBe(true);
      expect(event.kind).toBe("email");
      expect(event.sensitivity_hint).toBe("personal");
      expect(event.connector_id).toBe("kizuki.imap");
      expect(event.observed_at).toBe("2026-03-01T00:00:00.000Z");
      expect(event.deleted).toBe(false);
    }
  });

  test("a plain message", () => {
    const event = byId().get("42:1:INBOX");
    expect(event?.occurred_at).toBe("2026-03-01T08:00:00.000Z");
    expect(event?.text).toBe("Weekly sync\n\nNotes are in the shared folder.");
    expect(event?.subjects).toEqual([
      {
        subject_id: "email:ada@acme.example",
        role: "from",
        display_name: "Ada",
      },
      {
        subject_id: "email:grace@acme.example",
        role: "to",
        display_name: "Grace",
      },
    ]);
    expect(event?.metadata).toMatchObject({
      folder: "INBOX",
      uid: 1,
      uidvalidity: 42,
      message_id: "<plain-1@acme.example>",
      has_html: false,
    });
  });

  test("an HTML-only message becomes readable text", () => {
    const event = byId().get("42:2:INBOX");
    expect(event?.text).toBe("Release notes\n\nShipped\nTagged");
    expect(event?.metadata["has_html"]).toBe(true);
    expect(event?.subjects.map((subject) => subject.role)).toEqual([
      "from",
      "to",
      "to",
    ]);
  });

  test("multipart/alternative prefers the plain part and keeps the list id", () => {
    const event = byId().get("42:3:INBOX");
    expect(event?.text).toBe("Both flavours\n\nPlain wins.");
    expect(event?.metadata["list_id"]).toBe("Team list <team.acme.example>");
    expect(event?.metadata["has_html"]).toBe(true);
  });

  test("base64 utf-8 keeps astral characters intact", () => {
    expect(byId().get("42:4:INBOX")?.text).toBe(
      "Celebration\n\nWe shipped! \u{1F602}",
    );
  });

  test("quoted-printable windows-1252 decodes", () => {
    expect(byId().get("42:5:INBOX")?.text).toBe(
      "Cafe notes\n\nMet at the café on the corner.",
    );
  });

  test("encoded words decode in the subject and the display name", () => {
    const event = byId().get("42:6:INBOX");
    expect(event?.text.split("\n")[0]).toBe("Café résumé");
    expect(event?.subjects[0]?.display_name).toBe("Äda L");
  });

  test("a reply carries its thread headers", () => {
    const event = byId().get("42:7:INBOX");
    expect(event?.metadata["in_reply_to"]).toBe("<plain-1@acme.example>");
    expect(event?.metadata["references"]).toEqual([
      "<plain-1@acme.example>",
      "<alt-1@acme.example>",
    ]);
  });

  test("an attachment is a ref with a decoded RFC 2231 filename", () => {
    expect(byId().get("42:8:INBOX")?.attachments).toEqual([
      {
        attachment_id: "2",
        media_type: "application/pdf",
        filename: "café report.pdf",
        byte_size: 9,
      },
    ]);
  });

  test("an inline image is captured by its name parameter", () => {
    expect(byId().get("42:9:INBOX")?.attachments).toEqual([
      {
        attachment_id: "2",
        media_type: "image/png",
        filename: "mark.png",
        byte_size: 8,
      },
    ]);
  });

  test("an unsupported charset label is recorded rather than hidden", () => {
    expect(byId().get("42:10:INBOX")?.metadata["charset_fallback"]).toEqual([
      "iso-8859-2",
    ]);
  });

  test("a header-only capture says so and omits byte sizes", () => {
    const event = byId().get("42:11:INBOX");
    expect(event?.text).toBe("Very large export");
    expect(event?.metadata["body_omitted"]).toBe("size");
    expect(event?.attachments).toEqual([
      {
        attachment_id: "1",
        media_type: "application/zip",
        filename: "export.zip",
      },
    ]);
  });

  test("an unparsable Date falls back to INTERNALDATE", () => {
    const event = byId().get("42:12:INBOX");
    expect(event?.occurred_at).toBe("2026-03-01T08:55:00.000Z");
    expect(event?.metadata["date_header"]).toBe("not a date at all");
  });

  test("a trailing Date comment is stripped before parsing", () => {
    expect(byId().get("42:13:INBOX")?.occurred_at).toBe(
      "2026-03-01T09:00:00.000Z",
    );
  });

  test("no event carries IMAP flags in any field", () => {
    for (const event of fixtureEvents()) {
      expect(Object.keys(event.metadata)).not.toContain("flags");
      expect(JSON.stringify(event)).not.toContain('"flags"');
    }
  });
});

describe("mapping edges", () => {
  test("truncates very long text and says so", () => {
    const body = "x".repeat(MAX_TEXT_CODE_POINTS + 500);
    const event = build(
      `Subject: long\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
    );
    expect(Array.from(event.text)).toHaveLength(MAX_TEXT_CODE_POINTS);
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("skips malformed addresses and group syntax, and deduplicates", () => {
    const event = build(
      [
        "From: not-an-address",
        "To: Team: a@acme.example, b@acme.example;",
        "Cc: ada@acme.example, ADA@acme.example, two@@at.example",
        "Subject: addresses",
        "",
        "body",
        "",
      ].join("\r\n"),
    );
    expect(event.subjects).toEqual([
      { subject_id: "email:ada@acme.example", role: "to" },
    ]);
  });

  test("a message/rfc822 part is an attachment, not a nested walk", () => {
    const event = build(
      [
        "Subject: forwarded",
        "Content-Type: multipart/mixed; boundary=B",
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "see below",
        "--B",
        "Content-Type: message/rfc822",
        "Content-Disposition: attachment; filename=original.eml",
        "",
        "Subject: inner",
        "",
        "inner body",
        "--B--",
        "",
      ].join("\r\n"),
    );
    expect(event.text).toBe("forwarded\n\nsee below");
    expect(event.attachments).toEqual([
      {
        attachment_id: "2",
        media_type: "message/rfc822",
        filename: "original.eml",
        byte_size: 28,
      },
    ]);
  });

  test("strips path separators out of a filename", () => {
    const event = build(
      [
        "Subject: sneaky",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="../../etc/passwd"',
        "",
        "x",
        "",
      ].join("\r\n"),
    );
    expect(event.attachments).toEqual([
      {
        attachment_id: "1",
        media_type: "application/octet-stream",
        filename: "....etcpasswd",
        byte_size: 3,
      },
    ]);
  });

  test("an out-of-range entity in an html body still yields an event", () => {
    const event = build(
      [
        "From: linus@example.org",
        "Subject: Hostile",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>before &#1114112; after</p>",
        "",
      ].join("\r\n"),
    );
    expect(event.text).toBe("Hostile\n\nbefore &#1114112; after");
    expect(validateEventInput(event).ok).toBe(true);
  });

  test("a tombstone carries only the identity of what vanished", () => {
    const event = tombstoneEvent({
      folderWire: "INBOX",
      folderDisplay: "INBOX",
      uidvalidity: 42,
      uid: 7,
      observedAt: "2026-03-02T00:00:00.000Z",
      uidvalidityReset: true,
    });
    expect(event.deleted).toBe(true);
    expect(event.text).toBe("");
    expect(event.subjects).toEqual([]);
    expect(event.metadata).toEqual({
      folder: "INBOX",
      uid: 7,
      uidvalidity: 42,
      uidvalidity_reset: true,
    });
    expect(validateEventInput(event).ok).toBe(true);
  });
});
