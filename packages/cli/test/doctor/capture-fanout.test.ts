import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { accept, insertClaim } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function messageEvent(index: number): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "session-connector",
    source_record_id: `session-1/${index}`,
    kind: "message",
    occurred_at: "2026-09-01T09:00:00Z",
    observed_at: "2026-09-01T09:00:01Z",
    text: `turn ${index}`,
    subjects: [],
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

async function seedLegacyNotes(vault: string, count: number): Promise<void> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    for (let index = 0; index < count; index += 1) {
      const accepted = accept(db, messageEvent(index));
      if (accepted.status !== "stored") throw new Error("event was not stored");
      const eventId = accepted.event.event_id;
      const result = await insertClaim(
        { db },
        {
          kind: "claim",
          target: "captures/session-connector/2026-09-01",
          body: `Captured from \`session-connector\` (message) at 2026-09-01T09:00:00Z.\n\n> turn ${index}`,
          frontmatter: {
            type: "source",
            title: "Capture from session-connector at 2026-09-01T09:00:00Z",
            "x-connector": "session-connector",
            "x-capture-kind": "message",
          },
          provenance: [eventId],
          subjects: [],
          producer: "deterministic",
          confidence: 1,
          sensitivity: "private",
          taint: "quoted",
          events: [
            {
              event_id: eventId,
              connector_id: "session-connector",
              taint: "untrusted",
              text: `turn ${index}`,
            },
          ],
        },
      );
      if (result.outcome !== "stored")
        throw new Error(`fixture claim was ${result.outcome}`);
    }
  } finally {
    db.close();
  }
}

interface Report {
  data: {
    claims: {
      live: number;
      skipped: number;
      unwritten: number;
      capture_fanout: { pending: number; skipped: number };
    };
    filed_claims: unknown[];
  };
}

test("doctor counts capture notes of chat records apart from unwritten claims and names the repair", async () => {
  const setup = tempVault();
  await seedLegacyNotes(setup.vault, 3);

  const before = runCli(setup.env, "doctor", "--json");
  const beforeReport = JSON.parse(before.stdout) as Report;
  expect(beforeReport.data.claims.capture_fanout).toEqual({
    pending: 3,
    skipped: 0,
  });
  // These notes are repair work, never pending canon writes.
  expect(beforeReport.data.claims.unwritten).toBe(0);
  const human = runCli(setup.env, "doctor");
  expect(human.stdout).toContain(
    "capture fan-out skipped=0 pending=3 repair: kizuki serve run doctor-sweep",
  );

  const swept = runCli(setup.env, "serve", "run", "doctor-sweep", "--json");
  expect(swept.exitCode).toBe(0);
  expect(
    (JSON.parse(swept.stdout) as { data: { captures_skipped: number } }).data
      .captures_skipped,
  ).toBe(3);

  const after = runCli(setup.env, "doctor", "--json");
  const afterReport = JSON.parse(after.stdout) as Report;
  expect(afterReport.data.claims.capture_fanout).toEqual({
    pending: 0,
    skipped: 3,
  });
  expect(afterReport.data.claims.unwritten).toBe(0);
  expect(afterReport.data.claims.live).toBe(0);
  expect(afterReport.data.claims.skipped).toBe(3);
  expect(afterReport.data.filed_claims).toEqual([]);
  expect(runCli(setup.env, "doctor").stdout).toContain(
    "capture fan-out skipped=3 pending=0\n",
  );
});
