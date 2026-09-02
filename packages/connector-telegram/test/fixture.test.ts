import { expect, test } from "bun:test";
import { FIXTURE_ACCOUNT } from "../src/fixture";
import type { TelegramDialog, TelegramMessage } from "../src/api";
import { harness } from "./helpers";

test("the offline sample is not moved by what a caller does to the account", async () => {
  const { connector } = harness({ config: {} });
  const before = await connector.fixture();
  expect(before.length).toBeGreaterThan(0);

  // The account and the scripted client that mutates it are both exported, so
  // anything reaching for either must not be able to move what the conformance
  // suite measures this connector against.
  const dialog = FIXTURE_ACCOUNT.dialogs[0] as TelegramDialog;
  const history = FIXTURE_ACCOUNT.messages[dialog.peer_id] as TelegramMessage[];
  expect(() =>
    history.push({
      peer_id: dialog.peer_id,
      id: 9001,
      date: 1767225600,
      text: "added by a caller",
      out: false,
      service: false,
    }),
  ).toThrow();
  expect(await connector.fixture()).toEqual(before);
});
