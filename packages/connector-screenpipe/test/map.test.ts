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
  test("frame subjects preserve the exact app identity and site host", () => {
    expect(mapFrame(frame(), OBSERVED_AT).subjects).toEqual([
      {
        subject_id: "screenpipe:app:v2:QWNtZSBNYWls",
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

  test("a Unicode app name has a stable reversible subject", () => {
    expect(
      mapFrame(
        frame({ app_name: "日本語", browser_url: null }),
        OBSERVED_AT,
      ).subjects,
    ).toEqual([{ subject_id: "screenpipe:app:v2:5pel5pys6Kqe", role: "about", display_name: "日本語" }]);
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

  test("generic metadata keeps origin and path, not query secrets", () => {
    const event = mapFrame(
      frame({
        browser_url:
          "https://user:token@mail.acme.example/inbox/42?access_token=secret&tab=1#frag",
      }),
      OBSERVED_AT,
    );
    expect(event.metadata["browser_url"]).toBe(
      "https://mail.acme.example/inbox/42",
    );
    expect(JSON.stringify(event.metadata)).not.toContain("token");
    expect(JSON.stringify(event.metadata)).not.toContain("secret");
    expect(event.sensitivity_hint).toBe("private");
  });

  test("full URL retention is opt-in and stays private", () => {
    const event = mapFrame(
      frame({
        browser_url: "https://mail.acme.example/inbox/42?tab=1",
      }),
      OBSERVED_AT,
      { retainFullUrls: true },
    );
    expect(event.metadata["browser_url"]).toBe(
      "https://mail.acme.example/inbox/42?tab=1",
    );
    expect(event.sensitivity_hint).toBe("private");
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

  test("long text is cut at MAX_TEXT_CHARS and flagged", () => {
    const event = mapFrame(
      frame({ full_text: "x".repeat(MAX_TEXT_CHARS + 20) }),
      OBSERVED_AT,
    );
    expect(event.text).toHaveLength(MAX_TEXT_CHARS);
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("truncation never leaves a lone surrogate", () => {
    const event = mapFrame(
      frame({ full_text: "x".repeat(MAX_TEXT_CHARS - 1) + "😀tail" }),
      OBSERVED_AT,
    );
    expect(event.text).toBe("x".repeat(MAX_TEXT_CHARS - 1));
    expect(event.metadata["text_truncated"]).toBe(true);
  });

  test("punctuation, case, and Unicode identities never collide", () => {
    const left = mapFrame(frame({ app_name: "A/B", browser_url: null }), OBSERVED_AT);
    const right = mapFrame(frame({ app_name: "a b", browser_url: null }), OBSERVED_AT);
    const unicode = mapFrame(frame({ app_name: "Ａ／Ｂ", browser_url: null }), OBSERVED_AT);
    expect(new Set([left.subjects[0]?.subject_id, right.subjects[0]?.subject_id, unicode.subjects[0]?.subject_id]).size).toBe(3);
  });

  test("transcription occurred_at adds start_time", () => {
    const event = mapTranscription(transcription(), OBSERVED_AT);
    expect(event.occurred_at).toBe("2026-01-06T10:00:12.500Z");
    expect(event.subjects.map(({ subject_id }) => subject_id)).toEqual([
      "screenpipe:speaker:1",
      "screenpipe:audio-device:v2:TWFjQm9vayBNaWNyb3Bob25lIChpbnB1dCk",
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
      "d43e61b8c5ebf16b84c76c235c96421f58842b77105e26178bd5faa97abdd21e",
      "6ab95bdbdfcb18b7cb22409e8ee459fc81e070867919f79478d3959b79188eb2",
      "5231d39af256c222f8288ac348a1491cabc853a3f5fb98c2499a2cb30e9f99e2",
      "dd68a6cc7df7a147fd2778f3803fa73f87b654b4f3e9b557bc471fed439991b8",
      "fcef17c6245580e5698749d2f2ae817985bfa843fd318f86572803f056edf04d",
      "2f5e3eebc444aefc94ec1eac5b8a8ca51a8368e24dacb3d18159c1cd76b42df0",
      "645c182a35b0bb94852cfbdb697a2f8e079ae8b2696a1fbf31873738e6e0bcb1",
      "ba514502628e7957ed1ab565881f0cb8a41acc2531fa5d83bd1024bc5d1ba1cd",
    ]);
  });
});
