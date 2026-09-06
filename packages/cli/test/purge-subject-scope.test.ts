import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  accept,
  readSince,
  registerConnection,
  setSourceGrant,
  type PurgePreview,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
const CONNECTOR = "kizuki.subject-fixture";
const SUBJECT = "local:42";
const SOURCE_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

afterEach(cleanup);

function setup(managed = false, connectorId = CONNECTOR, subjectId = SUBJECT) {
  const fixture = tempVault();
  const db = openLedger(join(fixture.vault, ".kizuki", "kizuki.db"));
  try {
    if (managed) {
      for (const key of [SOURCE_A, SOURCE_B]) {
        registerConnection(db, connectorId, key);
        setSourceGrant(db, {
          source_key: key, expected_revision: 0, operation_id: `grant-${key}`,
          policy: {
            purposes: ["capture", "recall"],
            allowed_fields: ["text", "subjects", "attachments", "metadata"],
            retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
          },
        });
      }
    }
    const ids = [connectorId, managed ? connectorId : "kizuki.other-fixture"].map((connector, index) => {
      const result = accept(db, {
        schema: "kizuki.event/v1", connector_id: connector, source_record_id: `record-${index}`,
        kind: "message", occurred_at: "2026-09-06T12:00:00Z", observed_at: "2026-09-06T12:00:00Z",
        text: `Synthetic source ${index}`, subjects: [{ subject_id: subjectId, role: "about" }],
        sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
      }, managed ? { source: { source_key: index === 0 ? SOURCE_A : SOURCE_B, expected_revision: 1 } } : {});
      if (result.status !== "stored") throw new Error("synthetic fixture event was not stored");
      return result.event.event_id;
    });
    return { ...fixture, ids };
  } finally { db.close(); }
}

function remaining(vault: string): string[] {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try { return readSince(db, null, 10).events.map(event => event.event_id); }
  finally { db.close(); }
}

describe("namespaced subject purge CLI", () => {
  test("preserves exact connector and subject ids at the supported byte limits", () => {
    const connector = "c".repeat(128);
    const subject = "s".repeat(1024);
    const fixture = setup(false, connector, subject);
    const result = runCli(fixture.env, "purge", "--connector", connector, "--subject", subject,
      "--reason", "synthetic request", "--dry-run", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    const data = (JSON.parse(result.stdout) as { data: PurgePreview }).data;
    expect(data.filter).toEqual({ connector_id: connector, subject_handle: subject });
    expect(data.event_ids).toEqual([fixture.ids[0]!]);
    expect(remaining(fixture.vault)).toEqual(fixture.ids);
  });

  test("legacy subject preview and confirmed purge keep another connector's local id", () => {
    const fixture = setup();
    const args = ["purge", "--subject", SUBJECT, "--connector", CONNECTOR, "--reason", "synthetic subject request"];
    const preview = runCli(fixture.env, ...args, "--dry-run", "--json");
    expect(preview.exitCode, preview.stderr).toBe(0);
    const data = (JSON.parse(preview.stdout) as { data: PurgePreview }).data;
    expect(data.filter).toEqual({ connector_id: CONNECTOR, subject_handle: SUBJECT });
    expect(data.event_ids).toEqual([fixture.ids[0]!]);
    expect(remaining(fixture.vault)).toEqual(fixture.ids);

    const outcome = runCli(fixture.env, ...args, "--confirm");
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain("purged 1 event");
    expect(remaining(fixture.vault)).toEqual([fixture.ids[1]!]);
  });

  test("source-scoped preview prints the complete selector and purges only that source", () => {
    const fixture = setup(true);
    const args = ["purge", "--subject", SUBJECT, "--connector", CONNECTOR, "--source", SOURCE_A,
      "--reason", "synthetic subject request"];
    const text = runCli(fixture.env, ...args, "--dry-run");
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain(`selector connector_id=${CONNECTOR} subject_handle=${SUBJECT} source_key=${SOURCE_A}`);
    expect(text.stdout).toContain(`event_ids ${fixture.ids[0]}`);
    expect(text.stdout).not.toContain(fixture.ids[1]!);
    const preview = runCli(fixture.env, ...args, "--dry-run", "--json");
    expect(preview.exitCode, preview.stderr).toBe(0);
    const data = (JSON.parse(preview.stdout) as { data: PurgePreview }).data;
    expect(data.filter).toEqual({ connector_id: CONNECTOR, subject_handle: SUBJECT, source_key: SOURCE_A });
    expect(data.event_ids).toEqual([fixture.ids[0]!]);
    expect(remaining(fixture.vault)).toEqual(fixture.ids);

    const outcome = runCli(fixture.env, ...args, "--confirm");
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(remaining(fixture.vault)).toEqual([fixture.ids[1]!]);
  });

  test("bare subject ids receive an explicit namespace error", () => {
    const fixture = setup();
    const result = runCli(fixture.env, "purge", "--subject", SUBJECT, "--reason", "synthetic request", "--dry-run");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("subject purge requires --connector ID");
    expect(remaining(fixture.vault)).toEqual(fixture.ids);
  });

  test("source-bound subjects refuse preview and confirmed deletion when --source is missing", () => {
    const fixture = setup(true);
    for (const mode of ["--dry-run", "--confirm"]) {
      const result = runCli(fixture.env, "purge", "--subject", SUBJECT, "--connector", CONNECTOR,
        "--reason", "synthetic request", mode);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("subject purge requires source_key (--source KEY)");
      expect(remaining(fixture.vault)).toEqual(fixture.ids);
    }
  });

  test("source-scoped subject deletion still requires confirmation and refuses alias expansion", () => {
    const fixture = setup(true);
    const args = ["purge", "--subject", SUBJECT, "--connector", CONNECTOR, "--source", SOURCE_A,
      "--reason", "synthetic request"];
    const unconfirmed = runCli(fixture.env, ...args);
    expect(unconfirmed.exitCode).toBe(2);
    expect(unconfirmed.stderr).toContain("--confirm");
    const aliases = runCli(fixture.env, ...args, "--include-aliases", "--dry-run");
    expect(aliases.exitCode).toBe(1);
    expect(aliases.stderr).toContain("identity authority unavailable");
    expect(remaining(fixture.vault)).toEqual(fixture.ids);
  });

  test("rejects unsupported selector combinations before mutation", () => {
    const fixture = setup();
    for (const selectors of [
      ["--connector", CONNECTOR, "--source", SOURCE_A],
      ["--connector", CONNECTOR, "--subject", SUBJECT, "--record", "record-0"],
      ["--event", fixture.ids[0]!, "--connector", CONNECTOR, "--subject", SUBJECT],
    ]) {
      const result = runCli(fixture.env, "purge", ...selectors, "--reason", "synthetic request", "--dry-run");
      expect(result.exitCode).toBe(2);
      expect(remaining(fixture.vault)).toEqual(fixture.ids);
    }
    const verification = runCli(fixture.env, "purge", "--verify", SOURCE_A, "--source", SOURCE_B);
    expect(verification.exitCode).toBe(2);
    expect(remaining(fixture.vault)).toEqual(fixture.ids);
  });
});
