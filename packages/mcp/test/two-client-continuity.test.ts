import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { ToolCallResult } from "./client";

const BIN = join(import.meta.dir, "..", "src", "bin.ts");
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

interface ContinuityClient {
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
  leakText(): Promise<string>;
}

interface SeededContinuity {
  db: ReturnType<typeof openLedger>;
  vault: string;
  notes: string;
  aToken: string;
  bToken: string;
  project: string;
  marker: string;
  controlMarker: string;
  selectedSubject: string;
  selectedSourceKey: string;
}

function principalFor(db: SeededContinuity["db"], token: string): Principal {
  const value = authenticate(db, token);
  if (value === null) throw new Error("synthetic principal did not authenticate");
  return value;
}

function seedContinuity(): SeededContinuity {
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
  return { db, vault: setup.vault, notes: setup.notes, aToken, bToken, project, marker, controlMarker, selectedSubject, selectedSourceKey };
}

async function memoryClient(ctx: ServeContext): Promise<ContinuityClient> {
  const connected = await connectClient(ctx, closes);
  const index = closes.length - 1;
  let closed = false;
  return {
    call: (name, args) => call(connected, name, args),
    close: async () => {
      if (closed) return;
      closed = true;
      const stop = closes[index];
      closes[index] = async () => {};
      if (stop !== undefined) await stop();
    },
    leakText: async () => "",
  };
}

async function stdioClient(vault: string, token: string): Promise<ContinuityClient> {
  const child = Bun.spawn(
    [process.execPath, BIN, "--vault", vault, "--token-env", "KIZUKI_AGENT_TOKEN"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpdir(),
        KIZUKI_SUPERVISOR: "none",
        KIZUKI_AGENT_TOKEN: token,
      },
    },
  );
  let next = 0;
  let stdout = "";
  let stopped = false;
  let closed = false;
  let terminal: Error | undefined;
  const pending = new Map<number, { resolve(reply: { result?: ToolCallResult }): void; reject(error: Error): void }>();
  const diagnostics = new Response(child.stderr).text();
  function fail(reason = "protocol failed") {
    terminal = new Error(`MCP continuity ${reason}`);
    for (const waiting of pending.values()) waiting.reject(terminal);
    pending.clear();
  }
  const reading = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        const chunk = decoder.decode(read.value, { stream: true });
        stdout += chunk;
        buffer += chunk;
        if (stdout.length > 262_144) throw new Error("bounded fixture output exceeded");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const message = JSON.parse(line) as { id?: number; result?: ToolCallResult };
          if (message.id !== undefined) {
            pending.get(message.id)?.resolve(message);
            pending.delete(message.id);
          }
        }
      }
      if (buffer.trim() || pending.size) fail("protocol ended before replying");
    } catch {
      fail();
      child.kill("SIGKILL");
    } finally {
      stopped = true;
      reader.releaseLock();
    }
  })();
  async function request(method: string, params: unknown): Promise<{ result?: ToolCallResult }> {
    if (terminal || stopped) throw new Error("MCP continuity process ended");
    const id = ++next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("MCP continuity request timed out"));
        }, 10_000);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      child.stdin.end();
    } finally {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await child.exited;
        await reading;
        await diagnostics;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  closes.push(close);
  let initialized = false;
  try {
    const reply = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "continuity", version: "0" },
    });
    expect(reply.result).toBeDefined();
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await request("tools/list", {});
    const tools = (listed.result as { tools?: { outputSchema?: { properties?: object; required?: string[] } }[] } | undefined)?.tools;
    expect(tools?.length).toBeGreaterThan(0);
    for (const tool of tools ?? []) {
      expect(tool.outputSchema?.properties).toHaveProperty("has_withheld");
      expect(tool.outputSchema?.properties).toHaveProperty("source_policy");
      expect(tool.outputSchema?.required ?? []).not.toContain("has_withheld");
      expect(tool.outputSchema?.required ?? []).not.toContain("source_policy");
    }
    initialized = true;
    return {
      async call(name, args) {
        const tool = await request("tools/call", { name, arguments: args });
        if (tool.result === undefined) throw new Error("MCP continuity tool returned no result");
        return tool.result;
      },
      close,
      async leakText() {
        if (!closed) return stdout;
        return stdout + await diagnostics;
      },
    };
  } finally {
    if (!initialized) await close();
  }
}

async function proveContinuity(seed: SeededContinuity, a: ContinuityClient, b: ContinuityClient, reconnectB: () => Promise<ContinuityClient>) {
  const { db, vault, notes, aToken, bToken, project, marker, controlMarker, selectedSubject, selectedSourceKey } = seed;
  const timeline = await a.call("timeline", {});
  sameEnvelope(timeline);
  const quoted = envelopeOf(timeline).quoted as { event_id: string; text: string }[];
  const event = quoted.find((entry) => entry.text.includes(marker));
  const controlEvent = quoted.find((entry) => entry.text.includes(controlMarker));
  if (event === undefined || controlEvent === undefined) throw new Error("public timeline missing imported fixtures");
  expect(event.text).toContain("Project two-client-continuity is blocked.");
  const filed = await a.call("propose", {
    kind: "claim", target: "projects/two-client-continuity", body: "The project status is blocked.",
    subject: project, subjects: [project], predicate: "project.status", object: "blocked",
    provenance: [event.event_id],
  });
  sameEnvelope(filed);
  const claimId = (envelopeOf(filed).data as { claim_id: string }).claim_id;

  const initial = await b.call("context_packet", {
    subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
  });
  sameEnvelope(initial);
  expect(packet(envelopeOf(initial)).packet_md).toContain("blocked");

  const correctionArgs = {
    statement: "The project is active.", target: { claim_id: claimId }, object: "active",
  };
  const corrected = await a.call("correct", correctionArgs);
  sameEnvelope(corrected);
  const correction = envelopeOf(corrected).data as { claim_id: string; event_id: string; superseded: { claim_id: string }[] };
  expect(correction.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
  expect(envelopeOf(corrected).data).toMatchObject({ receipt_id: null });
  const retry = await a.call("correct", correctionArgs);
  sameEnvelope(retry);
  expect(envelopeOf(retry).data).toMatchObject({ claim_id: correction.claim_id, event_id: correction.event_id });

  for (const client of [a, b]) {
    const refreshed = await client.call("context_packet", {
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
    vault, notes, aToken, bToken,
  ];
  const assertPrivateValuesAbsent = (result: Parameters<typeof envelopeOf>[0]) => {
    const serialized = JSON.stringify(result);
    for (const value of privateValues) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('"cause"');
  };

  const forbidden = await b.call("correct", correctionArgs);
  expect(forbidden.isError).toBe(true);
  expect(errorOf(forbidden).error).toBe("tool_not_granted");
  expect(JSON.parse(forbidden.content[0]!.text)).toEqual({ error: "tool_not_granted", message: "tool not granted", retry_after_seconds: null });
  assertPrivateValuesAbsent(forbidden);

  const latestB = await b.call("context_packet", {
    subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
  });
  const beforeNarrow = packet(envelopeOf(latestB));
  expect(beforeNarrow.packet_md).toContain("active");
  setGrant(db, "continuity-b", { subjects: [], tools: ["context_packet"] });
  const outOfScope = await b.call("context_packet", {
    subjects: [project], include: ["claims"], purpose: "correction", budget_tokens: 500,
  });
  expect(outOfScope.isError).toBe(true);
  expect(errorOf(outOfScope).error).toBe("subject_out_of_scope");
  expect(JSON.parse(outOfScope.content[0]!.text)).toEqual({ error: "subject_out_of_scope", message: "subjects outside the grant", retry_after_seconds: null });
  assertPrivateValuesAbsent(outOfScope);
  const narrowed = await b.call("context_packet", {
    include: ["claims"], purpose: "correction", budget_tokens: 500,
    capabilities: ["delta"], retain_prefix: true, prior_hash: beforeNarrow.packet_hash, epoch: beforeNarrow.claims_epoch,
  });
  sameEnvelope(narrowed);
  expect(packet(envelopeOf(narrowed)).delivery).toBe("full");
  assertPrivateValuesAbsent(narrowed);
  const aStillAllowed = await a.call("context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
  expect(packet(envelopeOf(aStillAllowed)).packet_md).toContain("active");

  const beforeReconnect = listAgents(db).map((agent) => agent.agent_id);
  await b.close();
  const reconnectedB = await reconnectB();
  expect(listAgents(db).map((agent) => agent.agent_id)).toEqual(beforeReconnect);
  const reconnectedPacket = await reconnectedB.call("context_packet", { include: ["claims"], budget_tokens: 500 });
  sameEnvelope(reconnectedPacket);
  expect(packet(envelopeOf(reconnectedPacket)).delivery).toBe("full");
  assertPrivateValuesAbsent(reconnectedPacket);

  revokeAgent(db, "continuity-b");
  const revoked = await reconnectedB.call("context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
  expect(revoked.isError).toBe(true);
  expect(errorOf(revoked).error).toBe("unknown_agent");
  expect(JSON.parse(revoked.content[0]!.text)).toEqual({ error: "unknown_agent", message: "unknown agent", retry_after_seconds: null });
  assertPrivateValuesAbsent(revoked);

  revokeSourceGrant(db, { source_key: selectedSourceKey, expected_revision: 1, operation_id: "two-client-source-revoke" });
  const sourceDenied = await a.call("context_packet", { subjects: [project], include: ["claims"], budget_tokens: 500 });
  sameEnvelope(sourceDenied);
  assertPrivateValuesAbsent(sourceDenied);
  const controlTimeline = await a.call("timeline", {});
  sameEnvelope(controlTimeline);
  expect(JSON.stringify(envelopeOf(controlTimeline))).toContain(controlMarker);
  expect(JSON.stringify(envelopeOf(controlTimeline))).toContain(controlEvent.event_id);

  await a.close();
  await reconnectedB.close();
  const transcripts = [await a.leakText(), await b.leakText(), await reconnectedB.leakText()];
  const captured = transcripts.filter((text) => text.length > 0);
  if (captured.length === 0) return;
  expect(captured).toHaveLength(transcripts.length);
  for (const text of captured) {
    expect(text).not.toContain(aToken);
    expect(text).not.toContain(bToken);
    expect(text).not.toContain('"cause"');
  }
}

test("synthetic InMemoryTransport clients preserve scoped correction continuity and revoke live access", async () => {
  const seed = seedContinuity();
  try {
    const agentIdsBeforeMissingToken = listAgents(seed.db).map((agent) => agent.agent_id);
    expect(authenticate(seed.db, "")).toBeNull();
    expect(listAgents(seed.db).map((agent) => agent.agent_id)).toEqual(agentIdsBeforeMissingToken);
    const ctx = (token: string): ServeContext => ({ db: seed.db, vaultPath: seed.vault, principal: principalFor(seed.db, token) });
    const a = await memoryClient(ctx(seed.aToken));
    const b = await memoryClient(ctx(seed.bToken));
    await proveContinuity(seed, a, b, () => memoryClient(ctx(seed.bToken)));
  } finally { seed.db.close(); }
}, 30_000);

test("stdio clients preserve scoped correction continuity and revoke live access", async () => {
  const seed = seedContinuity();
  try {
    const a = await stdioClient(seed.vault, seed.aToken);
    const b = await stdioClient(seed.vault, seed.bToken);
    await proveContinuity(seed, a, b, () => stdioClient(seed.vault, seed.bToken));
  } finally { seed.db.close(); }
}, 30_000);
