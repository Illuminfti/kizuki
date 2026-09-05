import type { CaptureEventInput } from "@kizuki/core";
import { mapPost } from "./map";
import { parseYtd } from "./ytd";

export const FIXTURE_OBSERVED_AT = "2024-01-02T03:04:05.000Z";
export const FIXTURE_ACCOUNT_ID = "123456789012345678";

export const FIXTURE_ACCOUNT_SOURCE = `window.YTD.account.part0 = [{"account":{"accountId":"${FIXTURE_ACCOUNT_ID}","username":"fixture_owner"}}];`;
export const FIXTURE_TWEETS_SOURCE = `window.YTD.tweets.part0 = ${JSON.stringify([
  { tweet: {
    id_str: "1742012345678901234",
    created_at: "Tue Jan 02 03:04:05 +0000 2024",
    full_text: "A synthetic archive post with a link.",
    lang: "en",
    entities: {
      urls: [{ expanded_url: "https://example.test/post" }],
      user_mentions: [{ id_str: "987654321", screen_name: "example" }],
    },
  } },
  { tweet: {
    id_str: "1742012345678901235",
    created_at: "Tue Jan 02 08:34:05 +0530 2024",
    full_text: "A second synthetic archive post.",
    lang: "en",
    entities: { urls: [], user_mentions: [] },
  } },
])};`;

const FIXTURE_IDENTITY = {
  account_id: FIXTURE_ACCOUNT_ID,
  username: "fixture_owner",
} as const;

export function fixtureEvents(): CaptureEventInput[] {
  const records = parseYtd(FIXTURE_TWEETS_SOURCE, "tweets", 0);
  return records.map((record, index) =>
    mapPost(record, 0, index, FIXTURE_IDENTITY, new Map(), FIXTURE_OBSERVED_AT).event
  );
}
