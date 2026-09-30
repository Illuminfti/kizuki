import { expect, test } from "bun:test";
import { claimKey, hashBody } from "../../src/claims/hash";
import { insertClaim } from "../../src/claims/store";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { serveContextPacket } from "../../src/serving/packet";
import type { ContextPacketData } from "../../src/serving/packet";
import type { Envelope, ServeContext } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { claimInput } from "../claims/helpers";
import { checkNoninterference, observe } from "../helpers/noninterference";
import type { ReadCase } from "../helpers/noninterference";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

interface Filed {
  subject: string;
  predicate: string;
  object: string;
  hidden: boolean;
  confidence?: number;
  now?: string;
  valid_from?: string;
  valid_to?: string | null;
}

/** A keyed claim the public-ceiling agent can read (`hidden: false`) or cannot (`hidden: true`). */
async function file(f: Fixture, input: Filed): Promise<string> {
  const event = f.events[input.hidden ? "private" : "public"] as string;
  const stored = await insertClaim(
    {
      db: f.db,
      ...(input.now === undefined ? {} : { now: () => input.now as string }),
    },
    claimInput(event, {
      subject: input.subject,
      subjects: [input.subject],
      predicate: input.predicate,
      object: input.object,
      body: `${input.subject} ${input.predicate} ${input.object}.`,
      sensitivity: input.hidden ? "private" : "public",
      confidence: input.confidence ?? 0.7,
      ...(input.valid_from === undefined
        ? {}
        : { valid_from: input.valid_from }),
      ...(input.valid_to === undefined ? {} : { valid_to: input.valid_to }),
    }),
  );
  if (stored.outcome !== "stored" && stored.outcome !== "contested")
    throw new Error(`fixture claim: ${stored.outcome}`);
  return stored.outcome === "stored"
    ? stored.claim.claim_id
    : stored.incoming.claim_id;
}


/** Populate scale fixtures in one transaction from an ordinarily admitted row. */
async function olderClaims(f: Fixture, count: number, hidden: boolean): Promise<void> {
  const template = await file(f, { subject: "person:older-0", predicate: "tool.uses", object: "Tool 0", hidden, now: "2025-01-01T00:00:00.000Z" });
  const fields = f.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('claims')").all().map(row => row.name);
  const overrides = new Set(["claim_id", "subject", "subjects", "body", "body_hash", "object", "claim_key"]);
  const insert = f.db.prepare(`INSERT INTO claims (${fields.join(",")}) SELECT ${fields.map(field => overrides.has(field) ? "?" : field).join(",")} FROM claims WHERE claim_id=?`);
  try {
    f.db.transaction(() => {
      for (let index = 1; index < count; index += 1) {
        const subject = `person:older-${index}`, object = `Tool ${index}`;
        const body = `${subject} tool.uses ${object}.`;
        const values: Record<string, string> = { claim_id: ulid(), subject, subjects: JSON.stringify([subject]), body, body_hash: hashBody(body), object, claim_key: claimKey(subject, "tool.uses") };
        insert.run(...fields.filter(field => overrides.has(field)).map(field => values[field]!), template);
      }
    })();
  } finally { insert.finalize(); }
}

async function packetAs(
  ctx: ServeContext,
): Promise<Envelope<ContextPacketData>> {
  return serveContextPacket(ctx, { purpose: "session", budget_tokens: 1200 });
}

/** What a reader sees of a session packet, minus the clock and the epoch on the header's second line. */
function view(envelope: Envelope<ContextPacketData>) {
  const data = envelope.data!;
  const lines = data.packet_md.split("\n");
  return {
    session: data.session,
    sections: data.sections,
    truncated: data.truncated,
    degraded: data.retrieval_degraded,
    body: [lines[0], ...lines.slice(2)],
  };
}

async function visibleState(f: Fixture): Promise<void> {
  await file(f, {
    subject: "person:ada",
    predicate: "employment.works_at",
    object: "Acme",
    hidden: false,
  });
  await file(f, {
    subject: "person:ada",
    predicate: "employment.works_at",
    object: "Beta",
    hidden: false,
  });
  await file(f, {
    subject: "person:ada",
    predicate: "employment.role",
    object: "Engineer",
    hidden: false,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: "2026-02-01T00:00:00.000Z",
  });
  await file(f, {
    subject: "person:ada",
    predicate: "employment.role",
    object: "Manager",
    hidden: false,
    valid_from: "2026-04-01T00:00:00.000Z",
  });
}

test("sixty-five newer claims the agent cannot read do not change its 'now' section", async () => {
  const f = await serveFixture();
  try {
    await file(f, {
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
      hidden: false,
    });
    const agent = f.agent("reader-public");
    const before = view(await packetAs(agent));
    expect(before.session?.now.served).toBeGreaterThan(0);
    for (let index = 0; index < 65; index += 1) {
      await file(f, {
        subject: `person:h${index}`,
        predicate: "tool.uses",
        object: `Hidden ${index}`,
        hidden: true,
      });
    }
    const after = view(await packetAs(agent));
    expect(after).toEqual(before);
  } finally {
    f.dispose();
  }
});

test("four hundred older claims do not erase a visible contradiction and gap from the packet", async () => {
  const f = await serveFixture();
  try {
    await visibleState(f);
    const readers = { agent: f.agent("reader-public"), owner: f.owner() };
    const before = {
      agent: view(await packetAs(readers.agent)),
      owner: view(await packetAs(readers.owner)),
    };
    for (const name of ["agent", "owner"] as const) {
      expect(before[name].body.join("\n"), name).toContain("- conflict key=");
      expect(before[name].body.join("\n"), name).toContain("- gap key=");
    }
    await olderClaims(f, 401, true);
    const after = {
      agent: view(await packetAs(readers.agent)),
      owner: view(await packetAs(readers.owner)),
    };
    // Lines that were in the packet and are gone, and lines that were not and are there, per reader.
    const drift = (name: "agent" | "owner") => ({
      lost: before[name].body.filter((line) => !after[name].body.includes(line)),
      gained: after[name].body.filter((line) => !before[name].body.includes(line)),
    });
    expect({ agent: drift("agent"), owner: drift("owner") }).toEqual({
      agent: { lost: [], gained: [] },
      owner: { lost: [], gained: [] },
    });
  } finally {
    f.dispose();
  }
});

test("the work a session packet does does not grow with claims the agent cannot read", async () => {
  const f = await serveFixture();
  try {
    await file(f, { subject: "person:ada", predicate: "employment.works_at", object: "Acme", hidden: false });
    const agent = f.agent("reader-public");
    const read = {
      name: "session packet",
      run: (ctx: ServeContext) => serveContextPacket(ctx, { purpose: "session", budget_tokens: 1200 }),
    };
    await observe(agent, read);
    const first = await observe(agent, read);
    const control = await observe(agent, read);
    // The control: an unchanged vault costs the same every time, so a difference below is the claims'.
    expect(control.stats).toEqual(first.stats);
    for (let index = 0; index < 20; index += 1) {
      await file(f, { subject: `person:w${index}`, predicate: "tool.uses", object: `Hidden ${index}`, hidden: true });
    }
    const after = await observe(agent, read);
    expect(after.stats).toEqual(control.stats);
  } finally {
    f.dispose();
  }
});

const CONNECTION = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}';

function enrol(f: Fixture, connector: string, sourceKey: string): void {
  f.db
    .query(`INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at) VALUES (?, ?, ?, '[]', ?)`)
    .run(connector, sourceKey, CONNECTION, "2026-02-27T09:00:00Z");
}

test("system_health lists only the connections that feed the agent's view", async () => {
  const f = await serveFixture();
  try {
    const hiddenKey = ulid();
    // A second source of the connector the agent reads from, holding nothing the agent can read.
    enrol(f, "fixture", hiddenKey);
    const envelope = (await dispatchServeTool(f.agent("reader-public"), "system_health", {})) as Envelope<unknown>;
    expect(JSON.stringify(envelope)).not.toContain(hiddenKey);
  } finally {
    f.dispose();
  }
});

test("the label-overflow flag does not count label claims the agent cannot read", async () => {
  const f = await serveFixture();
  try {
    const agent = f.agent("reader-public");
    const ask = async () => (await dispatchServeTool(agent, "query_entities", { type: "person" })) as Envelope<unknown>;
    const before = await ask();
    // Thirty-three handle claims about a subject the agent can read, none of which it may read.
    for (let index = 0; index < 33; index += 1) {
      await file(f, { subject: "person:ada", predicate: "identity.handle_on", object: `@hidden${index}`, hidden: true });
    }
    const after = await ask();
    expect(after.data).toEqual(before.data);
  } finally {
    f.dispose();
  }
});

test.each(["2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"])("an oversized claim at %s leaves room for later fitting claims", async (assertedAt) => {
  const f = await serveFixture();
  try {
    // Exercise both the old oldest-first order and the new newest-first order.
    await file(f, { subject: "person:q0", predicate: "tool.uses", object: '"\\'.repeat(500), hidden: false, now: assertedAt });
    for (let index = 1; index <= 5; index += 1) {
      await file(f, { subject: `person:q${index}`, predicate: "tool.uses", object: `plain-${index}`, hidden: false, now: `2026-09-01T00:0${index}:00.000Z` });
    }
    const served = async (budget: number) =>
      (await serveContextPacket(f.owner(), { purpose: "recall", budget_tokens: budget, include: ["claims"] })).data!.sections.claims;
    // Five short claims fit in 900 tokens on their own; the packet at 900 must not be emptier than one at 2000 by more than the big one.
    expect(await served(900)).toBeGreaterThanOrEqual(5);
  } finally {
    f.dispose();
  }
});


// Unrelated readable rows must not consume the counterevidence window either.
test.each([401, 5000])("newest contradictions and gaps survive %i unrelated claims for every principal", async (count) => {
  const f = await serveFixture();
  try {
    await olderClaims(f, count, false);
    await visibleState(f);
    for (const ctx of [f.owner(), f.agent("reader-public")]) {
      const packet = await packetAs(ctx);
      expect(packet.data?.packet_md).toContain("- conflict key=");
      expect(packet.data?.packet_md).toContain("- gap key=");
    }
  } finally { f.dispose(); }
});

test("recall ranks matching working knowledge before newer unrelated claims and uses recency for ties", async () => {
  const f = await serveFixture();
  try {
    const older = await file(f, { subject: "person:older", predicate: "tool.uses", object: "kettle planning", hidden: false, now: "2026-01-01T00:00:00.000Z" });
    const newer = await file(f, { subject: "person:newer", predicate: "tool.uses", object: "kettle planning", hidden: false, now: "2026-02-01T00:00:00.000Z" });
    for (let index = 0; index < 25; index += 1) {
      await file(f, { subject: `person:unrelated-${index}`, predicate: "tool.uses", object: `Unrelated ${index}`, hidden: false, now: "2026-03-01T00:00:00.000Z" });
    }
    const packet = (await serveContextPacket(f.agent("reader-public"), { purpose: "recall", query: "kettle", include: ["claims"], budget_tokens: 2000 })).data!;
    const lines = packet.packet_md.split("\n").filter(line => line.startsWith("- [claim:"));
    expect(lines[0]).toContain(newer);
    expect(lines[1]).toContain(older);
    const recent = (await serveContextPacket(f.agent("reader-public"), { purpose: "recall", include: ["claims"], budget_tokens: 2000 })).data!;
    expect(recent.packet_md).not.toContain(older);
  } finally { f.dispose(); }
});

test("a readable interval bridging two shorter intervals prevents a false gap", async () => {
  const f = await serveFixture();
  try {
    await file(f, { subject: "person:coverage", predicate: "employment.role", object: "Long role", hidden: false, valid_from: "2020-01-01T00:00:00Z", valid_to: "2024-01-01T00:00:00Z" });
    await file(f, { subject: "person:coverage", predicate: "employment.role", object: "Short role", hidden: false, valid_from: "2021-01-01T00:00:00Z", valid_to: "2022-01-01T00:00:00Z" });
    await file(f, { subject: "person:coverage", predicate: "employment.role", object: "Later role", hidden: false, valid_from: "2023-01-01T00:00:00Z" });
    const data = (await serveContextPacket(f.agent("reader-public"), { purpose: "recall", include: ["claims"], budget_tokens: 2000 })).data!;
    expect(data.packet_md).not.toContain("- gap key=");
  } finally { f.dispose(); }
});
