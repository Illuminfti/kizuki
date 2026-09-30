import { expect, test } from "bun:test";
import { EVENT_LIMITS, validateEventInput } from "@kizuki/core";
import { createBeeperConnector } from "../src/connector";

test("Beeper refuses provider records outside ingress bounds before advancing", async () => {
  let text = "x".repeat(EVENT_LIMITS.textBytes + 1);
  const connector = createBeeperConnector({ token_secret_ref: "env:SYNTHETIC_BEEPER_TOKEN" }, {
    now: () => new Date("2026-01-15T12:00:00Z"),
    fetch: async () => Response.json({ items: [{ id: "1", accountID: "1", chatID: "1", sortKey: "1", timestamp: "2026-01-15T12:00:00Z", text }], hasMore: false }),
  });
  await connector.connect(async () => "synthetic-token");
  try {
    await expect(connector.backfill(null)).rejects.toMatchObject({ code: "parse_error" });
    text = "synthetic evidence";
    const retry = await connector.backfill(null);
    expect(retry.events).toHaveLength(1);
    expect(validateEventInput(retry.events[0]).ok).toBe(true);
  } finally { await connector.revoke(); }
});
