import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addAgent,
  authenticate,
  initAgents,
  listConnections,
  readSince,
  listAgents,
  revokeAgent,
  revokeSourceGrant,
  setGrant,
  setSourceGrant,
} from "@kizuki/core";
import type { Grant, Principal, ServeContext } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
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
  const controlNotes = h.tempDir("kizuki-independent-control-");
  const controlNote = join(controlNotes, "independent-control.md");
  const marker = "two-client-payload-marker";
  const controlMarker = "independent-control-marker";
  writeFileSync(selectedNote, `Project two-client-continuity is blocked. ${marker}\n`);
  mkdirSync(controlNotes, { recursive: true });
  writeFileSync(controlNote, `Independent control evidence. ${controlMarker}\n`);
  const original = readFileSync(selectedNote, "utf8");
  const denied = h.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("connect grant --source");

  let selectedSourceKey: string | undefined;
  const consentDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const enrolled = listConnections(consentDb)[0];
    if (enrolled === undefined) throw new Error("denied import did not enroll selected source");
    selectedSourceKey = enrolled.source_key;
    setSourceGrant(consentDb, { source_key: enrolled.source_key, expected_revision: 0,
      operation_id: "two-client-import", policy });
  } finally { consentDb.close(); }
  const imported = h.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes);
  expect(imported.exitCode, imported.stderr).toBe(0);
  expect(readFileSync(selectedNote, "utf8")).toBe(original);

  const controlDenied = h.runCli(setup.env, "import", "markdown-folder", "--source", controlNotes);
  expect(controlDenied.exitCode).toBe(1);
  const controlDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const control = listConnections(controlDb).find((connection) => connection.source_key !== selectedSourceKey);
    if (control === undefined) throw new Error("denied control import did not enroll an independent source");
    setSourceGrant(controlDb, { source_key: control.source_key, expected_revision: 0,
      operation_id: "two-client-control-import", policy });
  } finally { controlDb.close(); }
  expect(h.runCli(setup.env, "import", "markdown-folder", "--source", controlNotes).exitCode).toBe(0);

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    initAgents(db);
    const importedEvents = readSince(db, null, 100).events;
    const selectedEvent = importedEvents.find((entry) => entry.text.includes(marker));
    const independentEvent = importedEvents.find((entry) => entry.text.includes(controlMarker));
    if (selectedEvent === undefined || independentEvent === undefined) throw new Error("public ledger reader missing imported fixtures");
    const selectedSubject = selectedEvent.subjects[0]?.subject_id;
    const controlSubject = independentEvent.subjects[0]?.subject_id;
    if (selectedSubject === undefined || controlSubject === undefined) throw new Error("fixture event missing native document subject");
    const project = "project:two-client-continuity";
    const aToken = addAgent(db, "continuity-a", {
      ...readGrant, subjects: [selectedSubject, controlSubject, project], tools: ["timeline", "context_packet", "propose", "correct"], relay_owner_corrections: true,
    }).token;
    const bToken = addAgent(db, "continuity-b", { ...readGrant, subjects: [selectedSubject, project] }).token;
    const principal = (token: string): Principal => {
      const value = authenticate(db, token);
      if (value === null) throw new Error("synthetic principal did not authenticate");
      return value;
    };
    // Trusted fixture setup only: absent authentication cannot construct an owner-default context.
    const agentIdsBeforeMissingToken = listAgents(db).map((agent) => agent.agent_id);
    expect(authenticate(db, "")).toBeNull();
    expect(listAgents(db).map((agent) => agent.agent_id)).toEqual(agentIdsBeforeMissingToken);
    const a = await client({ db, vaultPath: setup.vault, principal: principal(aToken) });
    const b = await client({ db, vaultPath: setup.vault, principal: principal(bToken) });

    const timeline = await call(a, "timeline", {});
    sameEnvelope(timeline);
    const quoted = envelopeOf(timeline).quoted as { event_id: string; text: string }[];
    const event = quoted.find((entry) => entry.text.includes(marker));
    const controlEvent = quoted.find((entry) => entry.text.includes(controlMarker));
    if (event === undefined || controlEvent === undefined) throw new Error("public timeline missing imported fixtures");
    expect(event.text).toContain("Project two-client-continuity is blocked.");
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
    expect(envelopeOf(corrected).data).toMatchObject({ receipt_id: null });
    const retry = await call(a, "correct", correctionArgs);
    sameEnvelope(retry);
    expect(envelopeOf(retry).data).toMatchObject({ claim_id: correction.claim_id, event_id: correction.event_id });

    for (const c of [a, b]) {
      const refreshed = await call(c, "context_packet", {
        subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
      });
      sameEnvelope(refreshed);
      expect(packet(envelopeOf(refreshed)).packet_md).toContain("active");
      expect(packet(envelopeOf(refreshed)).packet_md).toContain("owner_correction");
      expect(packet(envelopeOf(refreshed)).packet_md).not.toContain("blocked");
    }
    const privateValues = [
      marker, project, "blocked", "active", selectedSubject, event.event_id,
      claimId, correction.claim_id, correction.event_id, correctionArgs.statement,
      setup.vault, setup.notes,
    ];
    const assertPrivateValuesAbsent = (result: Parameters<typeof envelopeOf>[0]) => {
      const serialized = JSON.stringify(result);
      for (const value of privateValues) expect(serialized).not.toContain(value);
      expect(serialized).not.toContain('"cause"');
    };

    const forbidden = await call(b, "correct", correctionArgs);
    expect(forbidden.isError).toBe(true);
    expect(errorOf(forbidden).error).toBe("tool_not_granted");
    expect(JSON.parse(forbidden.content[0]!.text)).toEqual({ error: "tool_not_granted", message: "tool not granted", retry_after_seconds: null });
    assertPrivateValuesAbsent(forbidden);

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
    expect(JSON.parse(outOfScope.content[0]!.text)).toEqual({ error: "subject_out_of_scope", message: "subjects outside the grant", retry_after_seconds: null });
    assertPrivateValuesAbsent(outOfScope);
    const narrowed = await call(b, "context_packet", {
      include: ["claims"], purpose: "correction", budget_tokens: 500,
      capabilities: ["delta"], retain_prefix: true, prior_hash: beforeNarrow.packet_hash, epoch: beforeNarrow.claims_epoch,
    });
    sameEnvelope(narrowed);
    expect(packet(envelopeOf(narrowed)).delivery).toBe("full");
    assertPrivateValuesAbsent(narrowed);
    const aStillAllowed = await call(a, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    expect(packet(envelopeOf(aStillAllowed)).packet_md).toContain("active");

    const beforeReconnect = listAgents(db).map((agent) => agent.agent_id);
    const originalBClose = closes.pop();
    if (originalBClose === undefined) throw new Error("missing original B transport closer");
    await originalBClose();
    const reconnectedB = await client({ db, vaultPath: setup.vault, principal: principal(bToken) });
    expect(listAgents(db).map((agent) => agent.agent_id)).toEqual(beforeReconnect);
    const reconnectedPacket = await call(reconnectedB, "context_packet", { include: ["claims"], budget_tokens: 500 });
    sameEnvelope(reconnectedPacket);
    expect(packet(envelopeOf(reconnectedPacket)).delivery).toBe("full");
    assertPrivateValuesAbsent(reconnectedPacket);

    revokeAgent(db, "continuity-b");
    const revoked = await call(reconnectedB, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    expect(revoked.isError).toBe(true);
    expect(errorOf(revoked).error).toBe("unknown_agent");
    expect(JSON.parse(revoked.content[0]!.text)).toEqual({ error: "unknown_agent", message: "unknown agent", retry_after_seconds: null });
    assertPrivateValuesAbsent(revoked);

    revokeSourceGrant(db, { source_key: selectedSourceKey!, expected_revision: 1, operation_id: "two-client-source-revoke" });
    const sourceDenied = await call(a, "context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
    sameEnvelope(sourceDenied);
    assertPrivateValuesAbsent(sourceDenied);
    const controlTimeline = await call(a, "timeline", {});
    sameEnvelope(controlTimeline);
    expect(JSON.stringify(envelopeOf(controlTimeline))).toContain(controlMarker);
    expect(JSON.stringify(envelopeOf(controlTimeline))).toContain(controlEvent.event_id);
  } finally { db.close(); }
}, 30_000);
