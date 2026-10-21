import { expect, test } from "bun:test";
import { reinstateClaim } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { cardFixture } from "./card-fixture";

const LEARNED = "2030-01-09T00:00:00.000Z";
const assisted = { kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id: "learning/assisted" } };

function historical(f: Awaited<ReturnType<typeof cardFixture>>, valid: Record<string, string> = { kind: "all" }) {
  const concept = f.find();
  return collectReadFrames(() => serveWorldView(f.ctx, {
    operation: "concept", concept, valid, knownAt: { kind: "time", at: LEARNED },
  }));
}

function application(read: ReturnType<typeof historical>) {
  const result = read.result.data;
  if (!("result" in result) || !("data" in result.result) || result.result.data.schema !== "kizuki.concept-card/v1")
    throw new Error("historical card unavailable");
  expect(result.result.status).toBe("current");
  expect(result.result.data.coverage.gaps).not.toContain("traversal_limit");
  expect(result.result.data.knownAt.kind).toBe("snapshot");
  return result.result.data.learning.find(item => item.facet === "application")!;
}

test("historical assistance ignores held prefixes before the cap and performs the same work as the unheld control", async () => {
  let baseline: ReturnType<typeof historical>["frames"][number]["stats"] | undefined;
  for (const heldCount of [0, 260]) {
    const db = openLedger(":memory:"), f = await cardFixture(db);
    try {
      db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(LEARNED);
      await f.write("learning.application", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
      for (let i = 0; i < heldCount; i++) {
        const held = await f.write("learning.assistance", assisted, { subject: "task:one", context: [`context:${i}`, "person:ada"] });
        if (held.stored.outcome !== "stored") throw new Error("held fixture deduplicated");
        db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.rendering.body','owner access') WHERE claim_id=?")
          .run(held.stored.claim.claim_id);
      }
      await f.write("learning.assistance", assisted, { subject: "task:one", context: ["person:ada"] });
      const read = historical(f), item = application(read);
      expect(item.assistance).toBe("assisted");
      expect(item.assistanceEvidence).toHaveLength(1);
      const stats = read.frames[0]!.stats;
      if (baseline === undefined) baseline = { ...stats };
      else expect(stats).toEqual(baseline);
    } finally { f.dispose(); db.close(); }
  }
}, 120_000);

test("historical assistance uses the retained lifecycle valid window before selecting candidates", async () => {
  const db = openLedger(":memory:"), f = await cardFixture(db);
  try {
    db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(LEARNED);
    await f.write("learning.application", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
    const evidence = await f.write("learning.assistance", assisted, {
      subject: "task:one", context: ["person:ada"], until: "2026-01-02T00:00:00.000Z",
    });
    if (evidence.stored.outcome !== "stored") throw new Error("assistance fixture deduplicated");
    // Undo/reinstatement records a new effective bound without rewriting the
    // original admitted semantic. Temporal reads use that retained state.
    reinstateClaim(db, evidence.stored.claim.claim_id, null);
    const item = application(historical(f, { kind: "at", at: "2026-01-03T00:00:00.000Z" }));
    expect(item.assistance).toBe("assisted");
    expect(item.assistanceEvidence).toHaveLength(1);
    expect(item.assistanceEvidence[0]!.valid).toEqual({ kind: "known", from: "2026-01-01T00:00:00.000Z", until: null });
  } finally { f.dispose(); db.close(); }
}, 120_000);
