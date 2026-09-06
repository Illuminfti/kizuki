import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addAgent,
  authenticate,
  initAgents,
  listClaims,
  listConnections,
  openLedger,
  revokeAgent,
  revokeSourceGrant,
  setGrant,
  setSourceGrant,
} from "@kizuki/core";
import type { Grant, Principal, ServeContext } from "@kizuki/core";
import { createHelpers } from "../../cli/test/helpers";
import { call, connectClient, envelopeOf, errorOf } from "./client";

const h = createHelpers();
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  h.cleanup();
});

const policy = {
  purposes: ["capture", "recall", "session", "derive", "correction"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress: "local_only",
  sensitivity_floor: "private",
};

const readGrant: Partial<Grant> = {
  ceiling: "private",
  types: null,
  since: null,
  until: null,
  tools: ["timeline", "context_packet"],
  rate_limit_per_minute: 60,
  relay_owner_corrections: false,
};

function sameEnvelope(result: { content: { text: string }[]; structuredContent?: Record<string, unknown> }) {
  const text = result.content[0]?.text ?? "{}";
  if (result.structuredContent === undefined) throw new Error(text);
  expect(JSON.parse(text)).toEqual(result.structuredContent);
}

function packet(result: ReturnType<typeof envelopeOf>) {
  return result.data as {
    packet_md: string; packet_hash: string; claims_epoch: number;
    status: "current" | "superseded"; delivery: "full" | "unchanged";
  };
}

async function client(ctx: ServeContext) {
  return connectClient(ctx, closes);
}

test("synthetic InMemoryTransport clients preserve scoped correction continuity and revoke live access", async () => {
  const setup = h.tempVault();
  const selectedNote = join(setup.notes, "two-client-source.md");
  const marker = "two-client-payload-marker";
  writeFileSync(selectedNote, `Project two-client-continuity is blocked. ${marker}\n`);
  const original = readFileSync(selectedNote, "utf8");
  const denied = h.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("connect grant --source");

  const consentDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const enrolled = listConnections(consentDb)[0];
    if (enrolled === undefined) throw new Error("denied import did not enroll selected source");
    setSourceGrant(consentDb, { source_key: enrolled.source_key, expected_revision: 0,
      operation_id: "two-client-import", policy });
  } finally { consentDb.close(); }
  const imported = h.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes);
  expect(imported.exitCode, imported.stderr).toBe(0);
  expect(readFileSync(selectedNote, "utf8")).toBe(original);

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    initAgents(db);
    const event = db.query<{ event_id: string; subjects: string }, []>(
      "SELECT event_id, subjects FROM events ORDER BY occurred_at LIMIT 1",
    ).get();
    const source = db.query<{ source_key: string }, []>(
      "SELECT source_key FROM source_event_bindings LIMIT 1",
    ).get();
    if (event === null || source === null) throw new Error("import fixture missing source event");
    const documentSubject = (JSON.parse(event.subjects) as { subject_id: string }[])[0]?.subject_id;
    if (documentSubject === undefined) throw new Error("import fixture missing document subject");
    const project = "project:two-client-continuity";
    const scoped = { ...readGrant, subjects: [documentSubject, project] };
    const aToken = addAgent(db, "continuity-a", {
      ...scoped, tools: ["timeline", "context_packet", "propose", "correct"], relay_owner_corrections: true,
    }).token;
    const bToken = addAgent(db, "continuity-b", scoped).token;
    const principal = (token: string): Principal => {
      const value = authenticate(db, token);
      if (value === null) throw new Error("synthetic principal did not authenticate");
      return value;
    };
    const a = await client({ db, vaultPath: setup.vault, principal: principal(aToken) });
    const b = await client({ db, vaultPath: setup.vault, principal: principal(bToken) });

    const timeline = await call(a, "timeline", {});
    sameEnvelope(timeline);
    expect((envelopeOf(timeline).quoted as { event_id: string }[]).map((entry) => entry.event_id)).toContain(event.event_id);
    const filed = await call(a, "propose", {
      kind: "claim", target: "projects/two-client-continuity", body: "The project status is blocked.",
      subject: project, subjects: [project], predicate: "project.status", object: "blocked",
      provenance: [event.event_id],
    });
    sameEnvelope(filed);
    const claimId = (envelopeOf(filed).data as { claim_id: string }).claim_id;

    const initial = await call(b, "context_packet", {
      subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
    });
    sameEnvelope(initial);
    expect(packet(envelopeOf(initial)).packet_md).toContain("blocked");

    const correctionArgs = {
      statement: "The project is active.", target: { claim_id: claimId }, object: "active",
    };
    const corrected = await call(a, "correct", correctionArgs);
    sameEnvelope(corrected);
    const correction = envelopeOf(corrected).data as { claim_id: string; event_id: string; superseded: { claim_id: string }[] };
    expect(correction.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
    const retry = await call(a, "correct", correctionArgs);
    sameEnvelope(retry);
    expect(envelopeOf(retry).data).toMatchObject({ claim_id: correction.claim_id, event_id: correction.event_id });

    for (const c of [a, b]) {
      const refreshed = await call(c, "context_packet", {
        subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
      });
      sameEnvelope(refreshed);
      expect(packet(envelopeOf(refreshed)).packet_md).toContain("active");
      expect(packet(envelopeOf(refreshed)).packet_md).not.toContain("blocked");
    }
    const forbidden = await call(b, "correct", correctionArgs);
    expect(forbidden.isError).toBe(true);
    expect(errorOf(forbidden).error).toBe("tool_not_granted");

    const latestB = await call(b, "context_packet", {
      subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
    });
    const beforeNarrow = packet(envelopeOf(latestB));
    expect(beforeNarrow.packet_md).toContain("active");
    setGrant(db, "continuity-b", { subjects: [], tools: ["context_packet"] });
    const outOfScope = await call(b, "context_packet", {
      subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
    });
    expect(outOfScope.isError).toBe(true);
    expect(errorOf(outOfScope).error).toBe("subject_out_of_scope");
    expect(JSON.stringify(envelopeOf(outOfScope))).not.toContain(project);
    const narrowed = await call(b, "context_packet", {
      include: ["claims"], purpose: "correction", budget_tokens: 500,
      capabilities: ["delta"], retain_prefix: true, prior_hash: beforeNarrow.packet_hash, epoch: beforeNarrow.claims_epoch,
    });
    sameEnvelope(narrowed);
    expect(packet(envelopeOf(narrowed)).delivery).toBe("full");
    const narrowedEnvelope = JSON.stringify(envelopeOf(narrowed));
    expect(narrowedEnvelope).not.toContain("active");
    expect(narrowedEnvelope).not.toContain(marker);
    expect(narrowedEnvelope).not.toContain(claimId);
    expect(narrowedEnvelope).not.toContain(correction.event_id);
    const aStillAllowed = await call(a, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    expect(packet(envelopeOf(aStillAllowed)).packet_md).toContain("active");

    revokeAgent(db, "continuity-b");
    const revoked = await call(b, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    expect(revoked.isError).toBe(true);
    expect(errorOf(revoked).error).toBe("unknown_agent");

    revokeSourceGrant(db, { source_key: source.source_key, expected_revision: 1, operation_id: "two-client-source-revoke" });
    const sourceDenied = await call(a, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    sameEnvelope(sourceDenied);
    expect(packet(envelopeOf(sourceDenied)).packet_md).not.toContain("active");
    const claims = listClaims(db, { subject: project });
    expect(claims.find((claim) => claim.claim_id === correction.claim_id)?.receipt_id).toBeNull();
  } finally { db.close(); }
}, 30_000);
