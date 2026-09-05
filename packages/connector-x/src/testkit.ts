import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FIXTURE_ACCOUNT_SOURCE,
  FIXTURE_TWEETS_SOURCE,
} from "./fixture";

export {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_ACCOUNT_SOURCE,
  FIXTURE_OBSERVED_AT,
  FIXTURE_TWEETS_SOURCE,
} from "./fixture";

export async function writeFixtureArchive(root: string): Promise<void> {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(data, "account.js"), FIXTURE_ACCOUNT_SOURCE, { mode: 0o600 }),
    writeFile(path.join(data, "tweets.js"), FIXTURE_TWEETS_SOURCE, { mode: 0o600 }),
  ]);
}
