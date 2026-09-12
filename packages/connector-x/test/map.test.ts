import { expect, test } from "bun:test";
import { mapPost } from "../src";

const self = { account_id: "123", username: "owner" } as const;
const observed = "2026-01-01T00:00:00.000Z";

function record(tweet: Record<string, unknown>) {
  return {
    tweet: {
      id_str: "456",
      created_at: "Tue Jan 02 03:04:05 +0000 2024",
      full_text: "link",
      entities: { urls: [], user_mentions: [] },
      ...tweet,
    },
  };
}

function mapped(tweet: Record<string, unknown>) {
  return mapPost(record(tweet), 0, 0, self, new Map(), observed).event;
}

test("post links are preserved only for supported URL schemes", () => {
  expect(mapped({
    full_text: "link",
    entities: { urls: [{ expanded_url: "https://example.test/path" }], user_mentions: [] },
  }).metadata.urls).toEqual(["https://example.test/path"]);
  expect(() => mapped({
    full_text: "link",
    entities: { urls: [{ expanded_url: "javascript:alert(1)" }], user_mentions: [] },
  })).toThrow("unsupported scheme");
});

test("long-form note and extended text replace truncated full_text without slicing display_text_range", () => {
  const long = "A longer synthetic owner post that must not be replaced by the short preview.";
  const note = mapped({
    full_text: "short preview",
    truncated: true,
    display_text_range: [0, 5],
    note_tweet: {
      text: long,
      entities: {
        urls: [{ expanded_url: "https://example.test/long" }],
        user_mentions: [{ id_str: "8", screen_name: "peer" }],
      },
    },
    entities: {
      urls: [{ expanded_url: "https://example.test/short" }],
      user_mentions: [],
    },
  });
  expect(note.text).toBe(long);
  expect(note.metadata.urls).toEqual(["https://example.test/long"]);
  expect(note.subjects).toContainEqual({
    subject_id: "x:user:8", role: "about", display_name: "@peer",
  });
  expect(mapped({
    note_tweet: {
      text: "long @peer",
      entities: { mentions: [{ id: "8", username: "peer" }], urls: [] },
    },
  }).subjects).toContainEqual({
    subject_id: "x:user:8", role: "about", display_name: "@peer",
  });

  expect(mapped({
    full_text: "",
    note_tweet: { text: "recovered long body" },
  }).text).toBe("recovered long body");
  expect(mapped({
    full_text: "",
    text: "compat",
    extended_tweet: { full_text: "extended synthetic body" },
  }).text).toBe("extended synthetic body");

  const uncut = "Hello https://example.test/uncut world";
  expect(mapped({
    full_text: uncut,
    display_text_range: [0, 5],
  }).text).toBe(uncut);
  expect(() => mapped({
    full_text: "short preview",
    note_tweet: "not-an-object",
  })).toThrow("must be an object");
});

test("quoted and replied ids stay in metadata and foreign nested text is not spliced", () => {
  const event = mapped({
    full_text: "owner quote",
    in_reply_to_status_id_str: "888",
    in_reply_to_user_id_str: "777",
    quoted_status_id_str: "999",
    quoted_status: {
      id_str: "999",
      full_text: "FOREIGN_QUOTED_TEXT_MUST_NOT_IMPORT",
    },
  });
  expect(event.text).toBe("owner quote");
  expect(event.text).not.toContain("FOREIGN_QUOTED_TEXT_MUST_NOT_IMPORT");
  expect(event.metadata).toMatchObject({
    in_reply_to_post_id: "888",
    in_reply_to_user_id: "777",
    quoted_status_id: "999",
  });
  expect(event.subjects).toEqual([
    { subject_id: "x:user:123", role: "from", display_name: "@owner" },
    { subject_id: "x:user:777", role: "to" },
  ]);
  expect(() => mapped({
    quoted_status_id_str: "999",
    quoted_status: { id_str: "1000" },
  })).toThrow("conflicts");
});

test("Unicode owner text is preserved exactly and entity media does not become an attachment", () => {
  const text = "合成 cafe\u0301 🐦 العربية";
  const event = mapped({
    full_text: text,
    entities: {
      urls: [{ expanded_url: "https://example.test/media.jpg" }],
      user_mentions: [],
      media: [{ media_url_https: "https://example.test/media.jpg", type: "photo" }],
    },
    extended_entities: {
      media: [{ media_url_https: "https://example.test/media.jpg", type: "photo" }],
    },
  });
  expect(event.text).toBe(text);
  expect(event.text).not.toBe("合成 café 🐦 العربية");
  expect(event.attachments).toEqual([]);
  expect(event.metadata.urls).toEqual(["https://example.test/media.jpg"]);
});
