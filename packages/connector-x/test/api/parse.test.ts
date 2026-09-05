import { expect, test } from "bun:test";
import { parsePage } from "../../src/api/parse";
import { selection } from "../../src/api/state";

const selected = selection({ fields: ["relationships", "links", "media"], history_start: "2026-01-01T00:00:00Z", wire_profile: "tweet-v2" });
const post = () => ({ id: "100", author_id: "7", text: "short", created_at: "2026-01-02T12:00:00Z", edit_history_tweet_ids: ["99", "100"],
  note_tweet: { text: "A longer synthetic owner post.", entities: { mentions: [{ id: "8", username: "peer" }], urls: [{ expanded_url: "https://example.test/post" }] } },
  in_reply_to_user_id: "9", referenced_tweets: [{ type: "replied_to", id: "90" }], attachments: { media_keys: ["3_100"] } });
const page = () => ({ data: [post()], meta: { result_count: 1, newest_id: "100", oldest_id: "100" }, includes: { media: [{ media_key: "3_100", type: "photo", url: "https://pbs.twimg.com/media/synthetic.jpg" }] } });

test("API-shaped posts preserve owner identity, occurrence, long text, relationships, edit chain and media references", () => {
  const parsed = parsePage(page(), "7", selected, "2026-01-03T00:00:00Z");
  expect(parsed.next).toBeNull();
  expect(parsed.events).toHaveLength(1);
  expect(parsed.events[0]).toMatchObject({ connector_id: "kizuki.x", source_record_id: "post:100", kind: "post", text: "A longer synthetic owner post.",
    occurred_at: "2026-01-02T12:00:00Z", observed_at: "2026-01-03T00:00:00Z", sensitivity_hint: "private", deleted: false,
    subjects: [{ subject_id: "x:user:7", role: "from" }, { subject_id: "x:user:9", role: "to" }, { subject_id: "x:user:8", role: "about" }] });
  expect(parsed.events[0]?.metadata).toMatchObject({ account_id: "7", post_id: "100", edit_history_ids: ["99", "100"], urls: ["https://example.test/post"] });
  expect(JSON.stringify(parsed.events[0]?.metadata?.media_refs)).toContain("https://pbs.twimg.com/media/synthetic.jpg");
});

test("documented aliases normalize once and conflicting or incomplete pages refuse", () => {
  const modern = page();
  const record = modern.data[0]! as Record<string, unknown>;
  record.note_post = record.note_tweet; record.edit_history_post_ids = record.edit_history_tweet_ids; record.referenced_posts = record.referenced_tweets;
  expect(parsePage(modern, "7", selected, "2026-01-03T00:00:00Z")).toEqual(parsePage(page(), "7", selected, "2026-01-03T00:00:00Z"));
  for (const change of [
    (p: any) => { p.data[0].author_id = "8"; },
    (p: any) => { p.data[0].note_post = { text: "CANARY" }; },
    (p: any) => { p.data[0].note_post = null; },
    (p: any) => { p.data[0].edit_history_post_ids = null; },
    (p: any) => { p.data[0].referenced_posts = null; },
    (p: any) => { p.data[0].created_at = "yesterday CANARY"; },
    (p: any) => { p.errors = [{ detail: "CANARY" }]; },
    (p: any) => { p.meta.result_count = 2; },
    (p: any) => { p.data[0].note_tweet.entities.urls[0].expanded_url = "file:///tmp/CANARY"; },
    (p: any) => { p.data[0].edit_history_tweet_ids = ["99"]; },
    (p: any) => { p.data[0].text = "x".repeat(128 * 1024 + 1); },
  ]) {
    const changed = page(); change(changed);
    try { parsePage(changed, "7", selected, "2026-01-03T00:00:00Z"); throw Error("accepted invalid page"); }
    catch (error) { expect(String(error)).toContain("X API"); expect(String(error)).not.toContain("CANARY"); }
  }
});

test("empty continuation is resumable and optional field selection excludes its payload", () => {
  const empty = parsePage({ meta: { result_count: 0, next_token: "next-page" } }, "7", selected, "2026-01-03T00:00:00Z");
  expect(empty.events).toEqual([]); expect(empty.next).toBe("next-page");
  const minimal = parsePage(page(), "7", selection({ ...selected, fields: [] }), "2026-01-03T00:00:00Z");
  expect(minimal.events[0]?.subjects).toEqual([{ subject_id: "x:user:7", role: "from" }]);
  expect(minimal.events[0]?.attachments).toEqual([]);
  expect(minimal.events[0]?.metadata?.urls).toBeUndefined();
});
