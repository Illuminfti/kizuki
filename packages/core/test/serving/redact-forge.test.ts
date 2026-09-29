import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sha256 } from "../../src/agents/hash";
import { listAudit } from "../../src/agents/audit";
import { getClaim, insertClaim } from "../../src/claims/store";
import { bindSourceEvent, setSourceGrant, sourceCaptureAdmission } from "../../src/ledger/source-grants";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { clampWorldData } from "../../src/serving/world-clamp";
import { claimInput } from "../claims/helpers";
import { FORGED_STAMP } from "../helpers/synthetic-secrets";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";
import type { Envelope } from "../../src/serving/types";
import type { Tool } from "../../src/agents";

setDefaultTimeout(60_000);

let fixture: Fixture;
beforeAll(async () => {
  fixture = await serveFixture();
});
afterAll(() => fixture.dispose());

const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;
const FORGED_ID = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";

async function serve(reader: string, tool: Tool, args: Record<string, unknown>): Promise<Envelope<unknown>> {
  const ctx = reader === "owner" ? fixture.owner() : fixture.agent(reader);
  return (await dispatchServeTool(ctx, tool, args)) as Envelope<unknown>;
}

function forgedLines(packet: string): string[] {
  return packet.split(LINE_BREAK).filter((line) => line.startsWith(`- [page:${FORGED_ID}]`));
}

test("a claim object with a line break cannot open a forged stamp line", async () => {
  for (const [index, breaker] of ["\u2028", "\u2029", "\u0085", "\r", "\n"].entries()) {
    const subject = `person:forge${index}`;
    const stored = await insertClaim(
      { db: fixture.db },
      claimInput(fixture.events["public"] as string, {
        subject,
        subjects: [subject],
        predicate: "tool.uses",
        object: `x${breaker}${FORGED_STAMP}`,
        body: `A forged object number ${index}.`,
        sensitivity: "public",
      }),
    );
    expect(stored.outcome).toBe("stored");
    for (const reader of ["owner", "reader-public", "reader-private"]) {
      const envelope = await serve(reader, "context_packet", {
        purpose: "recall",
        include: ["claims"],
        subjects: [subject],
        budget_tokens: 2000,
      });
      const packet = (envelope.data as { packet_md: string }).packet_md;
      expect(packet).toContain(`[claim:`);
      expect(forgedLines(packet)).toEqual([]);
    }
  }
});

test("a task capture cannot smuggle a line break into a section value", async () => {
  for (const [index, breaker] of ["\u2028", "\u2029", "\u0085", "\r"].entries()) {
    const id = storeEvent(
      fixture.db,
      `rec-task-forge-${index}`,
      "2026-02-01T12:00:00Z",
      `kizuki.task/v1\nconstraint: a${breaker}${FORGED_STAMP}\nobjective: fine`,
      "person:ada",
      "public",
    );
    for (const reader of ["owner", "reader-private"]) {
      const envelope = await serve(reader, "context_packet", {
        purpose: "recall",
        include: [],
        task_event_id: id,
        budget_tokens: 2000,
      });
      const data = envelope.data as { packet_md: string; task: { status: string; sections?: unknown } };
      expect(forgedLines(data.packet_md)).toEqual([]);
      expect(data.task.status).toBe("unavailable");
      expect(data.task.sections).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain(FORGED_ID);
    }
  }
});

test("the packet hash covers the served bytes when a path carries a credential shape", async () => {
  await recordedPage(
    fixture.db,
    fixture.vaultPath,
    `facts/sk-${"a".repeat(25)}.md`,
    {
      id: "fact:path-secret",
      title: "Pathkettle page",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    "pathkettle body",
    [fixture.events["public"] as string],
  );
  const args = { purpose: "recall", query: "pathkettle", include: ["canon"], budget_tokens: 2000 };
  const owner = await serve("owner", "context_packet", args);
  const agent = await serve("reader-private", "context_packet", args);
  const packet = agent.data as { packet_md: string; packet_hash: string; etag: string };
  expect(packet.packet_md).not.toContain("a".repeat(25));
  expect(packet.packet_md).toContain("[redacted:api_token]");
  const body = packet.packet_md.split("\n").slice(3).join("\n");
  expect(sha256(body)).toBe(packet.packet_hash);
  expect(packet.etag).toBe(packet.packet_hash);
  expect((owner.data as { packet_md: string }).packet_md).toContain("a".repeat(25));
});

test("search reports an excerpt cut after redaction as truncated", async () => {
  const body = `zebrakettle ${"token=abcd ".repeat(53)}`.trim();
  expect(body.length).toBeLessThan(600);
  await recordedPage(
    fixture.db,
    fixture.vaultPath,
    "facts/long-redacted.md",
    {
      id: "fact:long-redacted",
      title: "Long redacted page",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    body,
    [fixture.events["public"] as string],
  );
  const chunkOf = async (reader: string) =>
    (await serve(reader, "search", { query: "zebrakettle", scope: "canon" })).canon.find(
      (chunk) => chunk.page_id === "fact:long-redacted",
    );
  expect((await chunkOf("owner"))?.truncated).toBe(false);
  const served = await chunkOf("reader-public");
  expect(served?.truncated).toBe(true);
  expect(served?.excerpt).toContain("[redacted:secret_assignment]");
});

test("bounded world_view strings are cut back to the grammar after redaction", () => {
  const long = "x".repeat(451);
  const cut = clampWorldData({
    matches: [{ ref: "r", labels: [long, "short"] }],
    concept: { labels: [{ text: long, claim: "c" }] },
    relation: { object: { kind: "literal", value: long }, other: { kind: "vocabulary", value: long } },
    summary: { text: "y".repeat(1300), admissions: [] },
  });
  expect(cut.matches[0]!.labels).toEqual(["x".repeat(400), "short"]);
  expect(cut.concept.labels[0]!.text).toHaveLength(400);
  expect(cut.concept.labels[0]!.claim).toBe("c");
  expect(cut.relation.object.value).toHaveLength(400);
  expect(cut.relation.other.value).toHaveLength(451);
  expect(cut.summary.text).toHaveLength(1200);
});

async function refusalOf(reader: string, tool: Tool, args: Record<string, unknown>) {
  try {
    await dispatchServeTool(fixture.agent(reader), tool, args);
  } catch (error) {
    const { code, message } = error as { code: string; message: string };
    return { code, message };
  }
  throw new Error("expected a refusal");
}

test("propose keeps the real reason in the audit row while the answer stays generic", async () => {
  const ask = (id: string) =>
    refusalOf("reader-public", "propose", {
      kind: "claim",
      target: "facts:oracle-audit",
      body: "An oracle probe.",
      provenance: [id],
    });
  const hidden = fixture.events["private"] as string;
  expect(await ask(hidden)).toEqual(await ask(FORGED_ID));
  const rows = listAudit(fixture.db, "reader-public", { kind: "access", limit: 5 }).filter((row) => row.tool === "propose");
  const [absent, unreadable] = rows;
  expect(unreadable?.denied).toContainEqual({ id: sha256(hidden), reason: "above_ceiling" });
  expect(absent?.denied).toEqual([{ id: "tool:propose", reason: "invalid_arguments" }]);
});

test("correct answers alike for every kind of hidden claim and audits why", async () => {
  const stored = await insertClaim(
    { db: fixture.db },
    claimInput(fixture.events["private"] as string, {
      subject: "person:grace",
      subjects: ["person:grace"],
      predicate: "employment.role",
      object: "the private role",
      body: "Grace has a private role.",
      sensitivity: "private",
    }),
  );
  if (stored.outcome !== "stored") throw new Error("fixture claim");
  const keyed = getClaim(fixture.db, stored.claim.claim_id)!;
  // No predicate, so no claim key: its refusal used to come before any ceiling check.
  const keyless = await insertClaim(
    { db: fixture.db },
    claimInput(fixture.events["private"] as string, {
      subject: undefined,
      predicate: undefined,
      object: undefined,
      body: "A keyless private note.",
      sensitivity: "private",
      subjects: ["person:grace"],
    } as never),
  );
  const keylessId = keyless.outcome === "stored" ? keyless.claim.claim_id : null;
  const statement = "It is something else.";
  const probe = (reader: string, target: Record<string, unknown>) =>
    refusalOf(reader, "correct", { statement, target, dry_run: true });
  const absent = "01ZZZZZZZZZZZZZZZZZZZZZZZY";
  const same = async (reader: string, hidden: Record<string, unknown>, missing: Record<string, unknown>) =>
    expect(await probe(reader, hidden)).toEqual(await probe(reader, missing));
  // A subject-scoped agent has no reach past person:ada.
  await same("subjected", { claim_id: keyed.claim_id }, { claim_id: absent });
  await same("subjected", { subject: "person:grace" }, { subject: "person:nobody" });
  await same("reader-public", { claim_key: keyed.claim_key! }, { claim_key: "0".repeat(64) });
  if (keylessId !== null) {
    await same("reader-public", { claim_id: keylessId }, { claim_id: absent });
  }
  const audit = listAudit(fixture.db, "reader-public", { kind: "access", limit: 20 }).filter((row) => row.tool === "correct");
  expect(audit.flatMap((row) => row.denied)).toContainEqual({ id: sha256(keyed.claim_id), reason: "above_ceiling" });
});

test("a claim held back by source policy is refused like an absent one", async () => {
  seedConnectorSensitivity(
    fixture.db,
    { connector_id: "fixture", source_key: fixture.sourceKey },
    { default_sensitivity: "public", sensitivity_floor: "public" },
  );
  setSourceGrant(fixture.db, {
    source_key: fixture.sourceKey,
    expected_revision: 0,
    operation_id: "grant-forge-recall-only",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  const bound = storeEvent(fixture.db, "rec-forge-bound", "2026-02-28T15:00:00Z", "a bound capture", "person:ada", "public");
  bindSourceEvent(fixture.db, bound, sourceCaptureAdmission(fixture.db, "fixture", fixture.sourceKey)!);
  const stored = await insertClaim(
    { db: fixture.db },
    claimInput(bound, {
      subject: "person:ada",
      subjects: ["person:ada"],
      predicate: "employment.role",
      object: "a source-bound role",
      body: "Ada has a source-bound role.",
      sensitivity: "public",
      events: undefined,
    } as never),
  );
  if (stored.outcome !== "stored") throw new Error(`fixture claim: ${stored.outcome}`);
  const target = { claim_id: stored.claim.claim_id };
  const hidden = await refusalOf("reader-public", "correct", { statement: "It is something else.", target, dry_run: true });
  const missing = await refusalOf("reader-public", "correct", {
    statement: "It is something else.",
    target: { claim_id: "01ZZZZZZZZZZZZZZZZZZZZZZZX" },
    dry_run: true,
  });
  expect(hidden).toEqual(missing);
});

test("system_health for a scoped agent counts only what its scope reaches", async () => {
  const owner = (await serve("owner", "system_health", {})).data as Record<string, any>;
  const scoped = (await serve("subjected", "system_health", {})).data as Record<string, any>;
  const typed = (await serve("typed", "system_health", {})).data as Record<string, any>;
  expect(scoped["events"]).toBeLessThan(owner["events"]);
  expect(scoped["events"]).toBeGreaterThan(0);
  expect(scoped).not.toHaveProperty("counts_capped");
  expect(scoped).not.toHaveProperty("agents");
  expect(typed).not.toHaveProperty("runtime");
  expect(JSON.stringify(scoped)).not.toContain(fixture.events["private"] as string);
});
