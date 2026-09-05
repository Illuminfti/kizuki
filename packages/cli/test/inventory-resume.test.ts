import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_ID, type PortContext } from "@kizuki/core";
import { openEmbeddedRetrievalPort, EMBEDDED_RETRIEVAL_ID } from "@kizuki/retrieval-pg";
import { createOwnedRetrievalInventory } from "../src/owned-retrieval-inventory";
import { createHelpers } from "./helpers";
import { SYNTHETIC_DOCS } from "../../core/test/contracts/fixtures";
const h = createHelpers(); afterEach(h.cleanup);

test("resumed maintenance cannot recreate a generation already removed while another store was busy", async () => {
  const f = h.tempVault();
  const context = (id: string): PortContext => ({ vault_path: f.vault, data_dir: join(f.vault, ".kizuki/retrieval", id), config: {}, clock: () => new Date().toISOString(), secrets: async () => "", logger: () => {} });
  const fts = createFts5RetrievalPort(context(FTS5_RETRIEVAL_ID));
  await fts.upsert(SYNTHETIC_DOCS); await fts.close();
  const held = await openEmbeddedRetrievalPort(context(EMBEDDED_RETRIEVAL_ID));
  let inventory = createOwnedRetrievalInventory(f.vault);
  const removed = join(context(FTS5_RETRIEVAL_ID).data_dir, "store");
  try {
    const first = await inventory.stores();
    expect(await first.stores.find(s => s.id.endsWith(FTS5_RETRIEVAL_ID))!.maintain!()).toEqual({ owned_file_maintenance: "complete" });
    expect(await first.stores.find(s => s.id.endsWith(EMBEDDED_RETRIEVAL_ID))!.maintain!()).toEqual({ owned_file_maintenance: "pending" });
    await inventory.close();
    expect(existsSync(removed)).toBe(false);
    inventory = createOwnedRetrievalInventory(f.vault);
    const resumed = await inventory.stores();
    expect(existsSync(removed)).toBe(false);
    const erased = resumed.stores.find(s => s.id.endsWith(FTS5_RETRIEVAL_ID))!;
    expect(erased.port).toBeUndefined();
    expect(await erased.maintain!()).toEqual({ owned_file_maintenance: "complete" });
    expect(existsSync(removed)).toBe(false);
  } finally { await inventory.close(); await held.close(); }
}, 30000);
