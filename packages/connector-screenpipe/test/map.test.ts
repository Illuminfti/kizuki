import { describe, expect, test } from "bun:test";
import {
  canonicalSerialize,
  validateEventInput,
} from "@kizuki/core";
import {
  MAX_TEXT_CHARS,
  createScreenpipeConnector,
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

  test("an app_name that slugs to nothing yields no app subject", () => {
    expect(
      mapFrame(
        frame({ app_name: "日本語", browser_url: null }),
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
        subject_id: "screenpipe:site:2001-db8-1",
        role: "about",
        display_name: "[2001:db8::1]",
      },
    ]);
    // Staging derives an entity handle from the segment after the last colon.
    const subjectId = subjects[0]?.subject_id ?? "";
    expect(subjectId.slice(subjectId.lastIndexOf(":") + 1)).toBe(
      "2001-db8-1",
    );
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
      "c8f286697358286082edd3e326b416454f3288a5cd614813d15c3029a3087528",
      "9449e9142f2baa11dd32d230597d253267361bdcbefa74d3c05bbee5dba9ce36",
      "cd816d47aedcf00772d6b08c4fbd0389b2470a4ff0f7948dccc0f26a81d9fc28",
      "1195dc565593e2f9e43425d98c6c80b5c31731eb1c52f5551125278b6cd69bed",
      "d58f6e00929d05c9127e78ac8e73a29fe565abe989a37ad01bbabfdeb9c914a5",
      "a597c78d15d314c7bbaf6fedb2ba4e9b3af6fc44fb9c1d7f6b7a02c2b2d6f490",
      "5f66a0146a68b062dcacd0b42ff6988a00905bfada1b58298b66059aef91d003",
      "da6ff79839fd55a8b27773a37a4205b007e28344bb45b863d2d53defd05292f5",
    ]);
  });
});
