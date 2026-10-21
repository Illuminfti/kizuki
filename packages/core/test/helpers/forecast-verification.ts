import { EMPTY_SUMMARY_MODEL } from "./world-consolidation";
import type { Database } from "bun:sqlite";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { accept } from "../../src/ledger/ledger";
import { servePropose } from "../../src/serving/propose";
import { serveWorldView } from "../../src/serving/world-view";
import { forecastJob } from "../../src/world/forecast/job";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { cardFixture } from "../world/card-fixture";
import { enrollSource } from "./world-seed";
import { literal, vocabulary } from "./situation-v2-fixture";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";

export const FORECAST_BOARD = "project:forecast-verification";
export const FORECAST_SUBJECTS = [FORECAST_BOARD, ...Array.from({ length: 10 }, (_, i) => `commitment:forecast-verification-${i}`)];
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const PURPOSES = ["capture", "derive", "recall", "correction", "export"] as const;

/** The positive scoring case crosses its real 20-resolution reporting gate.
 * Every record comes from the bounded job and independently filed evidence;
 * no forecast or admission journal row is synthesized for the matrix. */
export async function forecastVerificationFixture(db: Database) {
  const f = await cardFixture(db, { model: EMPTY_SUMMARY_MODEL, purposes: [...PURPOSES] });
  try {
    await f.write("world.kind", vocabulary("world/situation"), { subject: FORECAST_BOARD });
    await f.write("situation.label", literal("Forecast verification board"), { subject: FORECAST_BOARD });
    const due = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    for (let i = 0; i < 10; i++) {
      const subject = FORECAST_SUBJECTS[i + 1]!;
      await f.write("world.kind", vocabulary("world/commitment"), { subject });
      await f.write("commitment.label", literal(`Forecast item ${i}`), { subject });
      await f.write("commitment.due", literal(due), { subject });
      await f.write("commitment.deliverable", literal("reviewed"), { subject });
      await f.write("situation.has_commitment", { kind: "subject", ref: f.ref(subject) }, { subject: FORECAST_BOARD });
    }
    const actors = ["reporter", "observer"].map(name => {
      const agent = addAgent(db, `forecast-verification-${name}`, OWNER_AGENT_GRANT);
      const connector = `forecast.verification.${name}`;
      const source = enrollSource(db, connector, "public", undefined, undefined, [...PURPOSES]);
      const ctx = { ...f.ctx, principal: authenticate(db, agent.token)! };
      const found = serveWorldView(ctx, { operation: "find_situations", label: "Forecast verification board", ...WHEN }).data;
      if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw Error("forecast board missing");
      const card = serveWorldView(ctx, { operation: "situation", situation: found.result.data.matches[0]!.ref, card: "kizuki.situation-card/v2", ...WHEN }).data;
      if (!("result" in card) || !("data" in card.result) || card.result.data.schema !== "kizuki.situation-card/v2") throw Error("forecast commitments missing");
      return { ctx, connector, source, card: card.result.data as SituationCardV2 };
    });
    const file = async (actorIndex: number, index: number) => {
      const actor = actors[actorIndex]!, subject = FORECAST_SUBJECTS[index + 1]!;
      const event = accept(db, { ...validEvent(), occurred_at: new Date().toISOString(), connector_id: actor.connector,
        source_record_id: ulid(), text: `Independent forecast verification ${actorIndex} ${index} ${ulid()}`,
        sensitivity_hint: "public", subjects: [{ subject_id: subject, role: "about" }] },
      { source: { source_key: actor.source, expected_revision: 1 } });
      if (event.status !== "stored") throw Error("forecast capture failed");
      const ref = actor.card.commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === `Forecast item ${index}`)!.commitment;
      const answer = await servePropose(actor.ctx, { kind: "claim", subject, subjects: [subject],
        predicate: actorIndex === 0 ? "outcome.self_report" : "outcome.observation",
        object: JSON.stringify({ subjectRef: ref.token, task: "review", attempt: "first", criterion: "reviewed", artifactVersion: "draft-1", environment: "test", result: "met", assistance: "assisted", confounded: false }),
        body: "Independent review evidence", provenance: [event.event.event_id], confidence: 0.8 });
      if (answer.data?.outcome !== "stored") throw Error("forecast outcome was not admitted");
    };
    const run = () => forecastJob.run({ db, vaultPath: f.ctx.vaultPath, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: false });
    for (let i = 0; i < 10; i++) await file(0, i);
    await run(); await run();
    for (let i = 0; i < 10; i++) await file(1, i);
    await run(); await run(); await run();
    const scores = serveWorldView(f.ctx, { operation: "forecast_scores", ...WHEN }).data;
    if (!("result" in scores) || !("data" in scores.result) || scores.result.data.schema !== "kizuki.forecast-scores/v1" || scores.result.data.resolved !== 20) throw Error("forecast scoring positive control missing");
    return { dispose: () => f.dispose() };
  } catch (error) { f.dispose(); throw error; }
}
