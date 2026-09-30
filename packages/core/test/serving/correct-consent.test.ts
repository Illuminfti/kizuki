import { afterEach, expect, test } from "bun:test";
import { insertClaim, getClaim, listSupersessions } from "../../src/claims/store";
import { inspectSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { serveCorrect } from "../../src/serving/correct";
import { readWorldView } from "../../src/serving/world-view";
import { ServeError } from "../../src/serving/types";
import type { ServeContext } from "../../src/serving/types";
import { serveFixture, type Fixture } from "./helpers";
import { worldFixture } from "./world-fixture";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

function withdrawCorrection(live: Fixture, sourceKey: string): void {
  const grant = inspectSourceGrant(live.db, sourceKey)!;
  setSourceGrant(live.db, {
    source_key: sourceKey,
    expected_revision: grant.revision,
    operation_id: "withdraw-correction",
    policy: { ...grant.policy, purposes: grant.policy.purposes.filter((purpose) => purpose !== "correction") },
  });
}

function definitionTarget(ctx: ServeContext, world: Awaited<ReturnType<typeof worldFixture>>) {
  const discovery = readWorldView(ctx, {
    operation: "find_concepts", label: world.label,
    valid: { kind: "all" }, knownAt: { kind: "current" },
  });
  if ("status" in discovery || discovery.result.status !== "current" || !("matches" in discovery.result.data)) {
    throw new Error("missing discovery");
  }
  const card = readWorldView(ctx, {
    operation: "concept", concept: discovery.result.data.matches[0]!.ref,
    valid: { kind: "all" }, knownAt: { kind: "current" },
  });
  if ("status" in card || card.result.status !== "current" || !("definitions" in card.result.data)) {
    throw new Error("missing definition");
  }
  return { world_claim: card.result.data.definitions[0]!.claim };
}

function expectConsent(error: unknown, sourceKey: string): void {
  expect(error).toBeInstanceOf(ServeError);
  expect(error).toMatchObject({ code: "held" });
  expect((error as ServeError).message).toContain(`source ${sourceKey} does not permit correction`);
  expect((error as ServeError).message).toContain(
    `kizuki connect grant --source ${sourceKey} --policy POLICY.json --expected-revision 2 --operation-id OPERATION`,
  );
}

test("owner typed-world correction names the missing purpose and grant command before recording evidence", async () => {
  fixture = await serveFixture();
  const live = fixture;
  const world = await worldFixture(live.db);
  const target = definitionTarget(live.owner(), world);
  withdrawCorrection(live, world.sourceKey);
  const before = live.db.query("SELECT count(*) AS n FROM events").get();
  const error = await serveCorrect(live.owner(), { statement: "Use posterior odds.", target }).catch((error: unknown) => error);
  expectConsent(error, world.sourceKey);
  expect(getClaim(live.db, world.claims[2]!)?.status).toBe("live");
  expect(live.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
});

test.each([false, true])("owner legacy replay names withdrawn correction consent (unkeyed=%s)", async (unkeyed) => {
  fixture = await serveFixture();
  const live = fixture;
  const world = await worldFixture(live.db);
  const filed = await insertClaim({ db: live.db }, {
    kind: "claim", target: "facts:compiler", body: "The compiler ships nightly.",
    ...(unkeyed ? {} : { subject: "topic:compiler", predicate: "project.status", object: "nightly" }),
    subjects: ["topic:compiler"], provenance: [world.eventId], producer: "deterministic", confidence: 1,
  });
  if (filed.outcome !== "stored") throw new Error(filed.outcome);
  const args = { statement: "The compiler ships weekly.", target: { claim_id: filed.claim.claim_id } };
  const first = await serveCorrect(live.owner(), args);
  expect(first.data!.claim_id).toBeString();
  withdrawCorrection(live, world.sourceKey);
  const eventsBefore = live.db.query("SELECT count(*) AS n FROM events").get();
  const supersessionsBefore = listSupersessions(live.db);
  expectConsent(await serveCorrect(live.owner(), args).catch((error: unknown) => error), world.sourceKey);
  expect(live.db.query("SELECT count(*) AS n FROM events").get()).toEqual(eventsBefore);
  expect(listSupersessions(live.db)).toEqual(supersessionsBefore);
  // Withdrawal makes the recording invisible to agents; replay is no oracle.
  const agentError = await serveCorrect(live.agent("reader-private"), args).catch((error: unknown) => error);
  expect(agentError).toMatchObject({ code: "invalid_arguments", message: "invalid arguments: target.claim_id: names no live claim" });
});

test("a typed-world agent refusal reveals neither consent nor hidden target details", async () => {
  fixture = await serveFixture();
  const live = fixture;
  const world = await worldFixture(live.db, { floor: "private" });
  const agent = live.agent("reader-private");
  const visible = definitionTarget(agent, world);
  const hidden = definitionTarget(live.owner(), world);
  withdrawCorrection(live, world.sourceKey);
  const before = live.db.query("SELECT count(*) AS n FROM events").get();
  const consent = await serveCorrect(agent, { statement: "Use posterior odds.", target: visible }).catch((error: unknown) => error);
  expect(consent).toMatchObject({ code: "held", message: "source authorization does not permit this correction" });
  const hiddenError = await serveCorrect(live.agent("reader-public"), {
    statement: "Use posterior odds.", target: hidden,
  }).catch((error: unknown) => error);
  const unknownError = await serveCorrect(live.agent("reader-public"), {
    statement: "Use posterior odds.", target: { world_claim: { kind: "claim", token: "A".repeat(43) } },
  }).catch((error: unknown) => error);
  expect(hiddenError).toBeInstanceOf(ServeError);
  expect(hiddenError).toMatchObject({ code: (unknownError as ServeError).code, message: (unknownError as ServeError).message });
  expect(live.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
});
