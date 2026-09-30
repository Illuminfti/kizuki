import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCanonPagesReport, runToCompletion } from "../../packages/core/src/index";
import { openLedger } from "../../packages/core/src/internal";
import { LEGACY_EVENTS_CONNECTOR_ID } from "../../packages/connectors/src/index";
import { SOURCE_KEY, connector, createSource, createVault, scriptedProducer } from "./corpus";
import { extractTopics } from "./worker";

test("extraction resumes across one-call passes without spending the canon budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-extract-test-"));
  const source = join(root, "synthetic.sqlite"), vault = join(root, "vault");
  try {
    createSource(source, 512, 1);
    // Keep one record for each of two topics in the real importer's source format.
    const input = new Database(source);
    try { input.exec("DELETE FROM records WHERE ordinal >= 2"); }
    finally { input.close(); }
    createVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const scripted = scriptedProducer(vault);
    try {
      const importer = connector(source);
      await importer.connect(async () => { throw new Error("benchmark has no secrets"); });
      const imported = await runToCompletion(db, importer, LEGACY_EVENTS_CONNECTOR_ID, SOURCE_KEY, "backfill", { vault_path: vault });
      expect(imported.errors).toEqual([]);
      expect(imported.stored).toBe(2);
      await extractTopics(db, vault, scripted, 2, {
        max_calls_per_pass: 1, records_per_request: 1, max_input_tokens: 32_000, max_output_tokens: 8_192,
        max_pass_seconds: 600, max_calls_per_day: 100_000, max_output_tokens_per_day: 1_000_000_000,
      });
      expect(scripted.topics.size).toBe(2);
      expect(scripted.events.size).toBe(2);
      expect(listCanonPagesReport(vault).pages).toEqual([]);
    } finally { await scripted.producer.close(); db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
