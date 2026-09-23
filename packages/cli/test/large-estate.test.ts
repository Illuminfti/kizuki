import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { accept, count } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const helpers = createHelpers();
afterEach(helpers.cleanup);

/** Above the historical 10,000-record rebuild ceiling, and a realistic estate size. */
const RECORDS = 12_000;
const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/** Low entropy on purpose: eight words and a counter, no personal text. */
function seedEstate(vaultPath: string, records: number): void {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  try {
    db.transaction(() => {
      for (let index = 0; index < records; index += 1) {
        accept(db, {
          schema: "kizuki.event/v1",
          connector_id: "fixture",
          source_record_id: `estate-${index}`,
          kind: "message",
          occurred_at: "2026-09-01T00:00:00Z",
          observed_at: "2026-09-01T00:00:00Z",
          text: `record ${index} ${WORDS[index % WORDS.length]} estateword`,
          sensitivity_hint: "personal",
          subjects: [],
          deleted: false,
          attachments: [],
          metadata: {},
        });
      }
    }).immediate();
    expect(count(db)).toBe(records);
  } finally {
    db.close();
  }
}

describe("a large estate", () => {
  test(
    "catches up in one serve pass, answers without --degraded, and rebuilds",
    async () => {
      const fixture = helpers.tempVault();
      seedEstate(fixture.vault, RECORDS);

      const stale = await helpers.runCliAsync(fixture.env, "query", "estateword", "--json");
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain("index-behind-ledger");

      const pass = await helpers.runCliAsync(fixture.env, "serve", "--once", "--no-http", "--json");
      expect(pass.exitCode).toBe(0);

      const answered = await helpers.runCliAsync(fixture.env, "query", "estateword", "--json");
      expect(answered.exitCode).toBe(0);
      const payload = JSON.parse(answered.stdout);
      expect(payload.degraded ?? []).toEqual([]);
      expect(payload.data.hits.length).toBeGreaterThan(0);

      const rebuilt = await helpers.runCliAsync(fixture.env, "rebuild", "--json");
      expect(rebuilt.exitCode).toBe(0);
      expect(JSON.parse(rebuilt.stdout).data.floor_documents).toBe(RECORDS);

      // The rail is ok only once the index is current, and it is current now.
      const sweep = await helpers.runCliAsync(fixture.env, "serve", "run", "retrieval-sweep", "--json");
      expect(sweep.exitCode).toBe(0);
      const swept = JSON.parse(sweep.stdout).data;
      expect(swept.status).toBe("ok");
      expect(swept.retrieval.pending_ops).toBe(0);
      expect(swept.retrieval.degraded).toEqual([]);
    },
    600_000,
  );

  test(
    "a rebuild budget refusal names the actual count and the flag that raises it",
    async () => {
      const fixture = helpers.tempVault();
      seedEstate(fixture.vault, 32);

      const refused = await helpers.runCliAsync(
        fixture.env, "rebuild", "--max-entries", "1", "--json");
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("filesystem entry budget: 2 > 1");
      expect(refused.stderr).toContain("--max-entries");

      const raised = await helpers.runCliAsync(fixture.env, "rebuild", "--json");
      expect(raised.exitCode).toBe(0);
      expect(JSON.parse(raised.stdout).data.floor_documents).toBe(32);
    },
    120_000,
  );

  test(
    "budget options are validated and refused alongside --prune-old",
    async () => {
      const fixture = helpers.tempVault();
      for (const [args, diagnostic] of [
        [["rebuild", "--max-records"], "missing value for --max-records"],
        [["rebuild", "--max-records", "0"], "--max-records expects a positive integer"],
        [["rebuild", "--max-entries", "x"], "--max-entries expects a positive integer"],
        [["rebuild", "--max-source-bytes", "-1"], "--max-source-bytes expects a positive integer"],
        [
          ["rebuild", "--prune-old", "--max-source-bytes", "8"],
          "rebuild --prune-old cannot be combined with --layer, --port, --confirm, or a budget option",
        ],
      ] as const) {
        const result = await helpers.runCliAsync(fixture.env, ...args);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`error: ${diagnostic}`);
        expect(result.stderr).toContain("usage: kizuki rebuild");
      }
    },
    120_000,
  );
});
