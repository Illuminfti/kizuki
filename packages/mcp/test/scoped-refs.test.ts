import { expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS } from "@kizuki/core";
import { startServeHttp } from "../../core/src/serve/http";
import { tryWriteFlock } from "../../core/src/serve/flock";
import { WRITER_REFUSAL_V2 } from "../../core/src/contracts/scoped-tools";
import { envelopeOf } from "./client";
import { twoClients } from "./helpers/two-clients";

setDefaultTimeout(120_000);
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } };
function rawIdentityKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rawIdentityKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [...(["claim_id", "event_id", "page_id", "source_key", "receipt_id", "claim_key", "frontmatter", "path", "subject_labels"].includes(key) ? [key] : []), ...rawIdentityKeys(item)]);
}

test("real stdio clients round-trip typed evidence, observations, proposals and correction DTOs", async () => {
  const clients = await twoClients({ agent: { tools: [...TOOLS], ceiling: "private", relay_owner_corrections: true, rate_limit_per_minute: 200 } });
  try {
    const card = (await clients.readConcept(clients.agent)).card! as any;
    const definition = card.data.result.data.definitions[0];
    const observed = envelopeOf(await clients.agent.call("world_view", { operation: "observation", ref: definition.assessments[0].admission, ...WHEN })) as any;
    expect(observed.data.result.data.schema).toBe("kizuki.observation/v1");
    expect(rawIdentityKeys(observed)).toEqual([]);
    const timeline = envelopeOf(await clients.agent.call("timeline", {})) as any, quoted = timeline.quoted[0];
    const input = { kind: "claim", body: "The scoped preference is careful review.", subject: quoted.subjects[0], subjects: [quoted.subjects[0]], provenance: [quoted.eventVersion], predicate: "preference.prefers", object: { kind: "literal", value: "careful review" } };
    const proposal = envelopeOf(await clients.agent.call("propose", input)) as any;
    expect(proposal.data.outcome).toBe("stored");
    expect(envelopeOf(await clients.agent.call("propose", input)).data).toEqual({ ...proposal.data, outcome: "duplicate" });
    const reply = await clients.agent.call("correct", { statement: "The preference is explicit review.", target: proposal.data.claim, object: { kind: "literal", value: "explicit review" } });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const corrected = envelopeOf(reply) as any;
    expect(corrected.data.message).toBe("correction_recorded");
    expect(corrected.data.claim.kind).toBe("claim");
    expect(corrected.data.superseded).toEqual([proposal.data.claim]);
    for (const output of [timeline, proposal, corrected]) expect(rawIdentityKeys(output)).toEqual([]);
  } finally { await clients.close(); }
});

test("real stdio and HTTP return the same fixed refusal for contention and pending erasure without changing read refs", async () => {
  const clients = await twoClients({ agent: { tools: [...TOOLS], ceiling: "private", relay_owner_corrections: true, rate_limit_per_minute: 200 } });
  const server = startServeHttp({ db: clients.db, vaultPath: clients.vaultPath, host: "127.0.0.1", port: 0, token: "synthetic-refs-http-control" });
  try {
    const timeline = envelopeOf(await clients.agent.call("timeline", {})) as any, quoted = timeline.quoted[0];
    const card = (await clients.readConcept(clients.agent)).card! as any;
    const calls = [
      ["propose", { kind: "claim", body: "A writer refusal probe", subjects: [quoted.subjects[0]], provenance: [quoted.eventVersion] }],
      ["correct", { statement: "A current definition.", target: card.data.result.data.definitions[0].claim }],
    ] as const;
    const counts = () => ["events", "claims", "canon_receipts", "native_owner_evidence"].map(table => clients.db.query<{n:number},[]>(`SELECT count(*) n FROM ${table}`).get()!.n);
    const initial = counts();
    for (const mode of ["busy", "erasure"] as const) {
      const lock = mode === "busy" ? tryWriteFlock(clients.vaultPath) : null;
      if (mode === "busy") expect(lock).not.toBeNull();
      else clients.db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("hidden-refusal-path", "hidden-refusal-source", "hidden-intent", "hidden-digest");
      try {
        for (const [name, input] of calls) {
          const result = await clients.agent.call(name, input);
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content[0]!.text)).toEqual(WRITER_REFUSAL_V2);
          const response = await fetch(`${server.url}/v1/${name}`, { method: "POST", headers: { authorization: `Bearer ${clients.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(input) });
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual(WRITER_REFUSAL_V2);
          expect(counts()).toEqual(initial);
        }
        const again = envelopeOf(await clients.agent.call("timeline", { eventVersion: quoted.eventVersion })) as any;
        expect(again.quoted[0].eventVersion).toEqual(quoted.eventVersion);
      } finally { lock?.release(); }
    }
  } finally { await server.stop(); await clients.close(); }
});
