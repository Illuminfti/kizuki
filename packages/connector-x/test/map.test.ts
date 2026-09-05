import { expect, test } from "bun:test";
import { mapPost } from "../src";

const self = { account_id: "123", username: "owner" } as const;

test("post links are preserved only for supported URL schemes", () => {
  const record = (expanded_url: string) => ({ tweet: {
    id_str: "456",
    created_at: "Tue Jan 02 03:04:05 +0000 2024",
    full_text: "link",
    entities: { urls: [{ expanded_url }], user_mentions: [] },
  } });
  expect(mapPost(record("https://example.test/path"), 0, 0, self, new Map(),
    "2026-01-01T00:00:00.000Z").event.metadata.urls)
    .toEqual(["https://example.test/path"]);
  expect(() => mapPost(record("javascript:alert(1)"), 0, 0, self, new Map(),
    "2026-01-01T00:00:00.000Z")).toThrow("unsupported scheme");
});
