import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { count, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);

test("native folder capture refuses its own managed canon without storing evidence", () => {
  const f = h.tempVault();
  mkdirSync(join(f.vault, "auto"));
  writeFileSync(join(f.vault, "auto", "generated.md"), "SYNTHETIC_GENERATED_CANON\n");
  const unsafeEnrollment = h.runCli(f.env, "connect", "markdown-folder", "--source", f.vault);
  expect(unsafeEnrollment.exitCode).toBe(1);
  expect(unsafeEnrollment.stderr).toContain("source_contains_kizuki_vault");
  const enrolled = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(enrolled.exitCode).toBe(0);
  const source = enrolled.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const dbPath = join(f.vault, ".kizuki/kizuki.db"), db = openLedger(dbPath);
  try {
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-folder-boundary", policy: {
      purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
  } finally { db.close(); }
  // An already authorized folder may become a vault after enrollment. Recheck
  // at capture time, before publishing any evidence or a new checkpoint.
  mkdirSync(join(f.notes, ".kizuki"));
  const refused = h.runCli(f.env, "backfill", "markdown-folder", "--source", source);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("source_contains_kizuki_vault");
  expect(refused.stdout + refused.stderr).not.toContain("SYNTHETIC_GENERATED_CANON");
  const reopened = openLedger(dbPath);
  try { expect(count(reopened)).toBe(0); } finally { reopened.close(); }
});
