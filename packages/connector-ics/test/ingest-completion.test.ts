import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCheckpoint, registerConnection, runToCompletion, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createIcsConnector, ICS_CONNECTOR_ID } from "../src/connector";

const SOURCE = "01JJ0000000000000000000001";
const calendar = (summary: string | null) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...(summary === null ? [] : [
  "BEGIN:VEVENT", "UID:synthetic-completion@example.test", "DTSTART:20260302T090000Z", `SUMMARY:${summary}`, "END:VEVENT",
]), "END:VCALENDAR", ""].join("\r\n");

test("real ICS caller commits one snapshot, replays idempotently and retains sync removal history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ics-completion-"));
  const db = openLedger(":memory:");
  try {
    const path = join(directory, "calendar.ics"); writeFileSync(path, calendar("Synthetic calendarlark"));
    registerConnection(db, ICS_CONNECTOR_ID, SOURCE);
    setSourceGrant(db, { source_key: SOURCE, expected_revision: 0, operation_id: "synthetic-ics-grant", policy: {
      purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
    const connector = createIcsConnector({ path }, { now: () => new Date("2026-03-01T00:00:00Z") });
    await connector.connect(async () => { throw new Error("file import must not resolve secrets"); });
    const first = await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "backfill");
    expect(first).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(first.cursor).not.toBeNull(); expect(getCheckpoint(db, ICS_CONNECTOR_ID, SOURCE)?.cursor).toBe(first.cursor);
    const replay = await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "backfill");
    expect(replay).toMatchObject({ stored: 0, duplicates: 1, errors: [], cursor: first.cursor });
    expect((await connector.backfill(null)).events).toHaveLength(1);
    expect((await connector.backfill(first.cursor)).events).toHaveLength(1);

    setSourceGrant(db, { source_key: SOURCE, expected_revision: 1, operation_id: "synthetic-new-ics-grant", policy: {
      purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
    const restarted = createIcsConnector({ path }, { now: () => new Date("2026-03-01T00:00:00Z") });
    expect(await runToCompletion(db, restarted, ICS_CONNECTOR_ID, SOURCE, "backfill")).toMatchObject({ stored: 0, duplicates: 1, errors: [], cursor: first.cursor });

    writeFileSync(path, calendar("Synthetic changed calendarlark"));
    const edited = await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "backfill");
    expect(edited).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(edited.cursor).not.toBe(first.cursor);
    expect(await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "sync")).toMatchObject({ stored: 0, duplicates: 0, errors: [], cursor: edited.cursor });

    writeFileSync(path, calendar(null));
    const removed = await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "sync");
    expect(removed).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(JSON.parse(removed.cursor!).records).toEqual({});
    expect(await runToCompletion(db, connector, ICS_CONNECTOR_ID, SOURCE, "sync")).toMatchObject({ stored: 0, duplicates: 0, errors: [], cursor: removed.cursor });
    expect(db.query("SELECT count(*) AS n FROM events WHERE deleted = 1").get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
