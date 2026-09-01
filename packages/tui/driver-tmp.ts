import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, initVault, openLedger } from "@kizuki/core";
import { fileProposal, initStaging, proposalsForEvent } from "@kizuki/core/staging";
import { runReview } from "./src/index";
const root = mkdtempSync(join(tmpdir(), "kizuki-demo-"));
const vault = join(root, "life");
initVault(vault);
const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
initStaging(db);
const samples: [string, string, string][] = [
  ["person:ada", "Ada", "Met Ada at the library. She is starting a reading group on Thursdays and asked whether I would host the second session."],
  ["person:grace", "Grace", "Grace confirmed the 気づき launch review for Friday 10:00; bring the connector conformance results and the purge receipts."],
  ["person:linus", "Linus", "Linus: the kettle is on, come over whenever. Also he still has my copy of The Left Hand of Darkness."],
];
let n = 0;
for (const [id, name, text] of samples) {
  n += 1;
  const r = accept(db, { schema: "kizuki.event/v1", connector_id: "kizuki.import-chatgpt", source_record_id: `rec-${n}`, kind: "message", occurred_at: `2026-09-01T0${n}:15:00.000Z`, observed_at: "2026-09-01T09:00:00.000Z", text, subjects: [{ subject_id: id, role: "from", display_name: name }], deleted: false, attachments: [], metadata: {} });
  if (r.status !== "stored") throw new Error(r.status);
  for (const p of proposalsForEvent(r.event)) fileProposal(db, p);
}
const summary = await runReview({ db, vaultPath: vault, batch: true });
console.log(JSON.stringify(summary));
