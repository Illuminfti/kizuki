import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { cardFixture } from "../../core/test/world/card-fixture";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

test("world text carries definitions, relations, learning, attribution, evidence and uncertainty", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const f = await cardFixture(db);
  let closed = false;
  try {
    await f.write("concept.example", { kind: "literal", value: "A visible example" }, { mode: "reported", speaker: "person:ada" });
    await f.write("learning.application", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
    await f.write("learning.assistance", { kind: "vocabulary", ref: { kind: "vocabulary", id: "learning/assisted" } }, { subject: "task:one", context: ["person:ada"] });
    const ref = f.find();
    db.close();
    closed = true;
    const args = ["world", "--operation", "concept", "--ref", ref.token];
    const text = h.runCli(setup.env, ...args), json = h.runCli(setup.env, ...args, "--json");
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(json.exitCode).toBe(0);
    const card = JSON.parse(json.stdout).data.data.result.data;
    for (const line of ["Revise beliefs using evidence", "concept.example", "A visible example", "application", "assisted", "reported", "Confidence: 0.5", "Evidence:", "Coverage:", "Known at: current"]) expect(text.stdout).toContain(line);
    for (const relation of [...card.definitions, ...card.relations, ...card.learning.map((l: { assertion: unknown }) => l.assertion)]) {
      expect(text.stdout).toContain(relation.claim.token);
      for (const assessment of relation.assessments) for (const evidence of assessment.evidence) {
        expect(text.stdout).toContain(evidence.eventVersion.token);
        expect(text.stdout).toContain(evidence.admission.token);
      }
    }
  } finally { if (!closed) db.close(); f.dispose(); }
}, 120_000);
