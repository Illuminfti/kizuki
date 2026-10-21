import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeOf } from "../client";
import { goldenApp, world } from "./golden-app";
import type { StdioClient } from "./two-clients";
type GoldenApp = Awaited<ReturnType<typeof goldenApp>>;

export async function assertObservedProcedure(client: StdioClient) {
  const matches = (await world(client, { operation: "find_procedures", label: "Verify delivery" })).result.data.matches;
  expect(matches).toHaveLength(1);
  const card = (await world(client, { operation: "procedure", procedure: matches[0].ref })).result.data;
  expect(card.taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "met", goalAchieved: true, independentMastery: false }] });
}

export async function decisionStage(f: GoldenApp, owner: StdioClient, peer: StdioClient) {
  const situation = async (client: typeof owner) => {
    const ref = (await world(client, { operation: "find_situations", label: "Orchard release" })).result.data.matches[0].ref;
    return (await world(client, { operation: "situation", situation: ref, card: "kizuki.situation-card/v2" })).result.data;
  };
  const initial = await situation(owner); expect(initial.decisions).toHaveLength(1); expect(initial.decisions[0].status).toBe("decided");
  const correctionResult = await owner.call("correct", { target: initial.decisions[0].statement.claim, statement: "That was an idea, not a decision.", mode: "reclassify_mode", perspective_mode: "suggested", response_contract: "kizuki.envelope/v2" });
  expect(correctionResult.isError ?? false, JSON.stringify(correctionResult)).toBe(false);
  const correction = envelopeOf(correctionResult).data as any;
  for (const client of [owner, peer]) {
    const card = await situation(client); expect(card.decisions).toHaveLength(0);
    expect(card.uncertainty.some((row: any) => row.predicate === "decision.status" && row.perspective.mode === "suggested")).toBe(true);
  }
  expect(correction.receipt.kind).toBe("receipt"); expect(correction).not.toHaveProperty("receipt_id");
  const replay = await owner.call("correct", { target: { world_claim: initial.decisions[0].statement.claim }, statement: "That was an idea, not a decision.", mode: "reclassify_mode", perspective_mode: "suggested", response_contract: "kizuki.envelope/v1" });
  expect(replay.isError ?? false).toBe(false);
  await f.operate("undo", { receipt_id: (envelopeOf(replay).data as any).receipt_id, cascade: false });
  expect((await situation(owner)).decisions).toHaveLength(1); expect((await situation(peer)).decisions).toHaveLength(1);
}

export async function outcomeStage(f: GoldenApp, owner: StdioClient, artifactVersion: string) {
  const procedureRef = async (client: typeof owner) => (await world(client, { operation: "find_procedures", label: "Verify delivery" })).result.data.matches[0].ref;
  const procedure = async () => (await world(owner, { operation: "procedure", procedure: await procedureRef(owner) })).result.data;
  const first = await procedure(); expect(first.taskUsefulness.status).toBe("unknown");
  const actors: { client: typeof owner; name: string }[] = [];
  for (const name of ["golden-reporter", "golden-observer", "golden-reviewer"]) {
    const client = await f.agent(name, { ...f.peerGrant, tools: ["world_view", "timeline", "propose"] });
    const notes = f.h.tempDir(`${name}-notes-`); writeFileSync(join(notes, "outcome.md"), `${name} independently recorded the receipt verification for attempt-1.`);
    const source = (await f.operate("enroll", { provider: "markdown", path: notes })).source_key;
    await f.call("consent", { source_key: source, expected_revision: 0, operation_id: `${name}-consent`, policy: { purposes: ["capture", "recall", "derive", "correction", "export"], allowed_fields: ["text", "subjects", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
    await f.operate("capture", { source_key: source, mode: "backfill" });
    actors.push({ client, name });
  }
  const file = async (index: number, predicate: string, eventIndex = index) => {
    const actor = actors[index]!, ref = await procedureRef(actor.client);
    const evidence = { subjectRef: ref.token, task: "verify", attempt: "attempt-1", criterion: "required fields present", artifactVersion, environment: "synthetic-v1", result: predicate === "outcome.review" ? "accepted" : "met", assistance: "assisted", confounded: false };
    const captures = envelopeOf(await actor.client.call("timeline", {})).quoted as import("../../../core/src/contracts/scoped-tools").QuotedChunkV2[];
    const capture = captures.find(row => row.text.startsWith(actors[eventIndex]!.name));
    expect(capture).toBeDefined();
    const response = await actor.client.call("propose", { kind: "claim", subject: ref, predicate, object: { kind: "literal", value: JSON.stringify(evidence) },
      body: `Quoted synthetic ${predicate}`, provenance: [capture!.eventVersion], confidence: .7, response_contract: "kizuki.envelope/v2" });
    expect(response.isError ?? false, JSON.stringify(response)).toBe(false);
  };
  await file(0, "outcome.self_report"); await file(1, "outcome.observation", 0); await file(2, "outcome.review");
  expect((await procedure()).taskUsefulness.status).toBe("unknown");
  await file(1, "outcome.observation");
  const after = await procedure(); expect(after.taskUsefulness.status).toBe("observed");
  expect(after.taskUsefulness.evaluations[0].result).toBe("met"); expect(after.taskUsefulness.evaluations[0].goalAchieved).toBe(true);
  expect(after.taskUsefulness.evaluations[0].independentMastery).toBe(false); expect(after.evidenceStrength).toEqual(first.evidenceStrength);
}
