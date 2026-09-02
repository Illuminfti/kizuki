import { describe, expect, test } from "bun:test";
import {
  canonicalSerialize,
  validateEventInput,
} from "@kizuki/core";
import {
  MAX_TEXT_CHARS,
  createScreenpipeConnector,
  hostSlug,
  mapFrame,
  mapTranscription,
  siteHost,
  slug,
} from "../src";
import type { FrameRow, TranscriptionRow } from "../src";

const OBSERVED_AT = "2026-01-09T00:00:00.000Z";

function frame(overrides: Partial<FrameRow> = {}): FrameRow {
  return {
    id: 1,
    timestamp: "2026-01-05T09:00:00Z",
    app_name: "Acme Mail",
    window_name: "Inbox",
    browser_url: "https://mail.acme.example/inbox/42?tab=1",
    device_name: "Built-in Display",
    focused: true,
    full_text: "A synthetic message.",
    text_source: "accessibility",
    capture_trigger: "app_switch",
    snapshot_path: null,
    document_path: null,
    video_chunk_id: 1,
    offset_index: 0,
    ...overrides,
  };
}

function transcription(
  overrides: Partial<TranscriptionRow> = {},
): TranscriptionRow {
  return {
    id: 1,
    audio_chunk_id: 1,
    offset_index: 0,
    timestamp: "2026-01-06T10:00:00Z",
    transcription: "A synthetic transcript.",
    device: "MacBook Microphone (input)",
    is_input_device: true,
    speaker_id: 1,
    speaker_name: "Grace",
    transcription_engine: "fixture-engine",
    start_time: 12.5,
    end_time: 14,
    ...overrides,
  };
}

describe("screenpipe mapping", () => {
  test("frame subjects: app slug and site host", () => {
    expect(mapFrame(frame(), OBSERVED_AT).subjects).toEqual([
      {
        subject_id: "screenpipe:app:acme-mail",
        role: "about",
        display_name: "Acme Mail",
      },
      {
        subject_id: "screenpipe:site:mail.acme.example",
        role: "about",
        display_name: "mail.acme.example",
      },
    ]);
    expect(slug(" ＡＣＭＥ / Mail ")).toBe("acme-mail");
  });

  test("an app_name outside the ASCII subset still gets a subject", () => {
    const subjects = mapFrame(
      frame({ app_name: "日本語", browser_url: null }),
      OBSERVED_AT,
    ).subjects;

    // Reducing the name to the slug alphabet leaves nothing, so the id is a
    // fingerprint of the name. Emitting no subject at all would hide every app
    // named outside the Latin alphabet from the staging floor.
    expect(subjects).toEqual([
      {
        subject_id: "screenpipe:app:x-0nbamha",
        role: "about",
        display_name: "日本語",
      },
    ]);
    expect(slug("微信")).not.toBe(slug("メモ帳"));
    // A name that keeps a letter keeps it, and stays apart from the name it
    // would otherwise collapse onto.
    expect(slug("café")).not.toBe(slug("cafe"));
    expect(slug("café").startsWith("caf-")).toBe(true);
  });

  test("an app_name with no name in it yields no app subject", () => {
    expect(
      mapFrame(
        frame({ app_name: "   ", browser_url: null }),
        OBSERVED_AT,
      ).subjects,
    ).toEqual([]);
  });

  test("two long names that share a prefix stay different subjects", () => {
    const shared = "a".repeat(63);
    const one = slug(`${shared}.one.example`);
    const two = slug(`${shared}.two.example`);

    expect(one).not.toBe(two);
    expect(one.length).toBeLessThanOrEqual(64);
    expect(two.length).toBeLessThanOrEqual(64);
    // A cut that lands on a separator would leave it dangling at the end.
    expect(one.endsWith("-")).toBe(false);
    expect(one.endsWith(".")).toBe(false);
    // The same name always yields the same id, or a purge plan could not match.
    expect(slug(`${shared}.one.example`)).toBe(one);
  });

  test("a non-http browser_url yields no site subject and query strings never appear in subjects", () => {
    expect(siteHost("file:///home/ada/notes.txt")).toBeNull();
    expect(siteHost("not a url")).toBeNull();
    expect(siteHost("https://EXAMPLE.com./path?private=value")).toBe(
      "example.com",
    );
    const subjects = mapFrame(
      frame({ app_name: null, browser_url: "ssh://example.com/?secret=yes" }),
      OBSERVED_AT,
    ).subjects;
    expect(JSON.stringify(subjects)).not.toContain("secret");
    expect(subjects).toEqual([]);
  });

  test("a site subject id has no separator inside its own segment", () => {
    const subjects = mapFrame(
      frame({ app_name: null, browser_url: "https://[2001:db8::1]/inbox" }),
      OBSERVED_AT,
    ).subjects;

    expect(subjects).toEqual([
      {
        subject_id: "screenpipe:site:2001-db8-1-1pgckq5",
        role: "about",
        display_name: "[2001:db8::1]",
      },
    ]);
    // Staging derives an entity handle from the segment after the last colon.
    const subjectId = subjects[0]?.subject_id ?? "";
    expect(subjectId.slice(subjectId.lastIndexOf(":") + 1)).toBe(
      "2001-db8-1-1pgckq5",
    );
    // Collapsing the structure of an address would put two unrelated hosts on
    // one subject, and a purge plan for either would list the other's frames.
    expect(hostSlug("[::1]")).not.toBe(hostSlug("[1::]"));
    expect(hostSlug("mail.acme.example")).toBe("mail.acme.example");
  });

  test("snapshot becomes a jpeg attachment reference with basename only", () => {
    expect(
      mapFrame(
        frame({
          snapshot_path:
            "/home/ada/.screenpipe/data/2026-01-05-monitor-1.jpg",
        }),
        OBSERVED_AT,
      ).attachments,
    ).toEqual([
      {
        attachment_id: "snapshot",
        media_type: "image/jpeg",
        filename: "2026-01-05-monitor-1.jpg",
      },
    ]);
  });

  test("a snapshot path from another platform keeps only its last component", () => {
    expect(
      mapFrame(
        frame({
          snapshot_path: "C:\\Users\\ada\\.screenpipe\\data\\shot.jpg",
        }),
        OBSERVED_AT,
      ).attachments,
    ).toEqual([
      {
        attachment_id: "snapshot",
        media_type: "image/jpeg",
        filename: "shot.jpg",
      },
    ]);
    expect(
      mapFrame(frame({ snapshot_path: "/home/ada/data/" }), OBSERVED_AT)
        .attachments,
    ).toEqual([{ attachment_id: "snapshot", media_type: "image/jpeg" }]);
  });

  test("long text is cut at MAX_TEXT_CHARS and flagged", () => {
    const event = mapFrame(
      frame({ full_text: "x".repeat(MAX_TEXT_CHARS + 20) }),
      OBSERVED_AT,
    );
    expect(event.text).toHaveLength(MAX_TEXT_CHARS);
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("truncation cuts on a code point boundary", () => {
    const utf8RoundTrip = (text: string): string =>
      new TextDecoder().decode(new TextEncoder().encode(text));
    const screen = mapFrame(
      frame({ full_text: `${"a".repeat(MAX_TEXT_CHARS - 1)}\u{1f600}tail` }),
      OBSERVED_AT,
    );
    const spoken = mapTranscription(
      transcription({
        transcription: `${"b".repeat(MAX_TEXT_CHARS - 1)}\u{1f3a4}tail`,
      }),
      OBSERVED_AT,
    );

    expect(screen.text).toHaveLength(MAX_TEXT_CHARS - 1);
    expect(utf8RoundTrip(screen.text)).toBe(screen.text);
    expect(screen.metadata["text_truncated"]).toBe(true);
    expect(spoken.text).toHaveLength(MAX_TEXT_CHARS - 1);
    expect(utf8RoundTrip(spoken.text)).toBe(spoken.text);
  });

  test("text one unit past the bound ending in a pair is flagged", () => {
    // The narrowest case the flag has to survive: the cut lands between the
    // halves of the last pair, so the kept text is shorter than the bound
    // while the row was still longer than it.
    const event = mapFrame(
      frame({ full_text: `${"a".repeat(MAX_TEXT_CHARS - 1)}\u{1f600}` }),
      OBSERVED_AT,
    );

    expect(event.text).toHaveLength(MAX_TEXT_CHARS - 1);
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("transcription occurred_at adds start_time", () => {
    const event = mapTranscription(transcription(), OBSERVED_AT);
    expect(event.occurred_at).toBe("2026-01-06T10:00:12.500Z");
    expect(event.subjects.map(({ subject_id }) => subject_id)).toEqual([
      "screenpipe:speaker:1",
      "screenpipe:audio-device:macbook-microphone-input",
    ]);
  });

  test("speaker without a name has no display_name", () => {
    expect(
      mapTranscription(
        transcription({ speaker_id: 2, speaker_name: null }),
        OBSERVED_AT,
      ).subjects[0],
    ).toEqual({ subject_id: "screenpipe:speaker:2", role: "from" });
  });

  test("metadata carries no redaction or sync columns", () => {
    const events = [
      mapFrame(frame(), OBSERVED_AT),
      mapTranscription(transcription(), OBSERVED_AT),
    ];
    const serialized = JSON.stringify(events.map(({ metadata }) => metadata));
    for (const forbidden of [
      "redacted_at",
      "sync_id",
      "synced_at",
      "cloud_blob_id",
      "elements_ref_frame_id",
      "semantic_run_id",
      "speaker_name",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("every fixture event passes validateEventInput", async () => {
    const events = await createScreenpipeConnector({
      path: ":memory:",
    }).fixture();
    expect(events).toHaveLength(8);
    expect(events.every((event) => validateEventInput(event).ok)).toBe(true);
  });

  test("fixture hashes are stable", async () => {
    const events = await createScreenpipeConnector({
      path: ":memory:",
    }).fixture();
    const hashes = events.map((event) =>
      new Bun.CryptoHasher("sha256")
        .update(canonicalSerialize(event))
        .digest("hex"),
    );
    expect(hashes).toEqual([
      "cf3066a39b557e3e3902ed04355458cc8521d58e33bede9bdb22c4944ce82c90",
      "5b545bdf5a57fdd1ebf3d3347f015d8f8991d2d0a3a478d1763430089827d42a",
      "d5053f71fb031e32fff87e0b134a8d91692e7aac3fdde9d422964ff73fba2146",
      "88ea144a40897eb4eeecdc9a9b1e882c3a205c92979fd80b4f2cae36bbefda4c",
      "b44c29b7a21697c6640551572e8f0f0c6fad9b8a882d1b1f274354a56c056e75",
      "aa1087e0bd75fa889b94f0e4e20c0ce536762f97ccda1b85adccb86783bd8eb1",
      "95ee86fe88eeb57e0bc584fbe35ff2df459ba8070f71c797652da91de936b0e5",
      "01544c3e9d089af99adfd4213b29c2502fe055e657358f5bd784dc2f2d1717e6",
    ]);
  });
});
