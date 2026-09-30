// A bounded stream of canon writes into the synthetic vault named by argv[2].
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import { openLedger } from "../../src/ledger/db";
import { putEvent, storeClaim } from "../canon/helpers";

const vault = process.argv[2]!;
const db = openLedger(`${vault}/.kizuki/kizuki.db`);
for (let i = 0; i < 128; i++) {
  const event = putEvent(db, { source_record_id: `live-${i}`, text: `Person ${i} works at Acme.` });
  const claim = await storeClaim(db, event, {
    target: `people/person-${i}`, subject: `person:${i}`, body: `Person ${i} works at Acme.`,
    frontmatter: { type: "person", title: `Person ${i}` }, subjects: [`person:${i}`],
  });
  const io = { db, vault_path: vault };
  try {
    applyCanonWrite(io, claim, resolveTarget(io, claim), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) });
  } catch (error) {
    if ((error as { code?: string }).code !== "writer_busy") throw error;
  }
  if (i === 2) console.log("ready");
  // Give snapshots an acquisition window even when local writes are very fast.
  await Bun.sleep(10);
}
db.close();
