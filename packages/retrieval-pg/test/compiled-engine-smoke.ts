import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbeddedRetrievalPort } from "../src/port";
import { SYNTHETIC_DOCS, SYNTHETIC_QUERY } from "./helpers";

// This fixture is compiled and run with the checkout dependencies absent.
globalThis.fetch = Object.assign(async () => { throw new Error("unexpected runtime network request"); }, { preconnect: () => { throw new Error("unexpected runtime network preconnect"); } });
const dataDir = mkdtempSync(join(tmpdir(), "kizuki-compiled-sql-"));
const ctx = { vault_path: dataDir, data_dir: dataDir, config: {}, secrets: async () => "unused", clock: () => "2026-09-05T00:00:00.000Z", logger: () => {} };
let port = await openEmbeddedRetrievalPort(ctx);
try {
  await port.upsert(SYNTHETIC_DOCS);
  await port.close();
  port = await openEmbeddedRetrievalPort(ctx);
  const result = await port.search(SYNTHETIC_QUERY);
  if (result.hits.length !== 2) throw new Error("compiled SQL persistence proof failed");
  await port.remove(["page:grace"]);
  if ((await port.verifyAbsent(["page:grace"])).found.length !== 0) throw new Error("compiled SQL deletion proof failed");
  process.stdout.write("compiled SQL engine smoke passed\n");
} finally {
  await port.close();
  rmSync(dataDir, { recursive: true, force: true });
}
