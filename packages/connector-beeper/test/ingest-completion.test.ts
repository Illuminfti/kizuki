import { expect, test } from "bun:test";
import { getCheckpoint, registerConnection, runToCompletion, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { BEEPER_CONNECTOR_ID, BeeperConnector } from "../src";

const SOURCE = "01JJ0000000000000000000001";
const message = { id: "m1", accountID: "a1", chatID: "c1", senderID: "u1", sortKey: "001", timestamp: "2026-01-02T03:04:05Z", text: "Synthetic completion" };

for (const empty of [false, true]) {
  test(`the host records completion for ${empty ? "an empty" : "a paged"} Beeper history`, async () => {
    const db = openLedger(":memory:");
    let requests = 0;
    try {
      registerConnection(db, BEEPER_CONNECTOR_ID, SOURCE);
      setSourceGrant(db, { source_key: SOURCE, expected_revision: 0, operation_id: "synthetic-beeper-completion", policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
      } });
      const connector = new BeeperConnector({ token_secret_ref: "env:BEEPER_TOKEN" }, {
        fetch: async url => {
          requests++;
          const terminal = empty || url.searchParams.get("cursor") === "older";
          return Response.json(terminal ? { items: [], hasMore: false } : { items: [message], hasMore: true, oldestCursor: "older" });
        },
        now: () => new Date("2026-01-03T00:00:00Z"),
      });
      await connector.connect(async () => "synthetic-completion-token");
      const result = await runToCompletion(db, connector, BEEPER_CONNECTOR_ID, SOURCE, "backfill");
      expect(result).toMatchObject({ stored: empty ? 0 : 1, duplicates: 0, errors: [], cursor: null });
      expect(requests).toBe(empty ? 1 : 2);
      expect(getCheckpoint(db, BEEPER_CONNECTOR_ID, SOURCE)?.backfill_complete).toBe(true);
    } finally { db.close(); }
  });
}
