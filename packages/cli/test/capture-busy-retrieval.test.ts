import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { count, openLedger, revokeSourceGrant, setSourceGrant } from "@kizuki/core";
import { openEmbeddedRetrievalPort } from "@kizuki/retrieval-pg";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);

test("a live retrieval session cannot block source capture, idempotence or consent denial", async () => {
  const f = h.tempVault();
  const enrolled = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(enrolled.exitCode).toBe(0);
  const source = enrolled.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const file = join(f.vault, ".kizuki/kizuki.db"), db = openLedger(file);
  try { setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-capture", policy: {
    purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } }); } finally { db.close(); }
  const id = "kizuki.retrieval.embedded-pg";
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), `[ports]\nretrieval="${id}"\n`);
  const held = await openEmbeddedRetrievalPort({ vault_path: f.vault, data_dir: join(f.vault, ".kizuki/retrieval", id), config: {}, clock: () => new Date().toISOString(), secrets: async () => "", logger: () => {} });
  try {
    for (const args of [["backfill", "markdown-folder", "--source", source], ["sync", "markdown-folder", "--source", source], ["import", "markdown-folder", "--source", f.notes]]) {
      const result = h.runCli(f.env, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    const read = openLedger(file);
    try {
      expect(count(read)).toBe(3);
      revokeSourceGrant(read, { source_key: source, expected_revision: 1, operation_id: "fixture-deny" });
    } finally { read.close(); }
    const denied = h.runCli(f.env, "backfill", "markdown-folder", "--source", source);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("source_capture_denied");
    expect((await held.health()).status).toBe("ready");
  } finally { await held.close(); }
}, 30_000);
