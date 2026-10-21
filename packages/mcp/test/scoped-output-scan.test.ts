import { expect, test } from "bun:test";
import { TOOLS } from "@kizuki/core";
import { startServeHttp } from "../../core/src/serve/http";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { createHelpers } from "../../cli/test/helpers";
import { twoClients } from "./helpers/two-clients";
import { envelopeOf } from "./client";

const V2 = "kizuki.envelope/v2";
const KEYS = new Set(["page_id", "path", "event_id", "connector_id", "source_key", "claim_id", "claim_key", "receipt_id", "subject_labels", "frontmatter", "epoch", "source_policy", "denied"]);
function identityKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(identityKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [...(KEYS.has(key) ? [key] : []), ...identityKeys(item)]);
}

test("real stdio and HTTP scan all ten tools and CLI scans every scoped command for raw generated identities", async () => {
  const clients = await twoClients({ agent: { tools: [...TOOLS], ceiling: "private", relay_owner_corrections: true, rate_limit_per_minute: 300 } });
  const h = createHelpers(), env = h.isolatedEnv();
  const server = startServeHttp({ db: clients.db, vaultPath: clients.vaultPath, host: "127.0.0.1", port: 0, token: "synthetic-output-scan-control" });
  try {
    await recordedPage(clients.db, clients.vaultPath, "entities/scoped-scan.md", {
      id: "page:scoped-scan", title: "Scoped scan", type: "topic", status: "active", sensitivity: "public", taint: "quoted",
      subjects: ["topic:bayes"], sources: [clients.seed.eventId],
    }, "Scoped scan evidence.", [clients.seed.eventId]);
    const seen = new Set<string>();
    function scan(value: unknown) {
      expect(identityKeys(value)).toEqual([]);
      const json = JSON.stringify(value);
      const raw = ["page:scoped-scan", "entities/scoped-scan.md", "topic:bayes", clients.seed.sourceKey,
        ...clients.db.query<{ connector_id: string }, []>("SELECT DISTINCT connector_id FROM events").all().map(row => row.connector_id),
        ...clients.db.query<{ event_id: string }, []>("SELECT event_id FROM events").all().map(row => row.event_id),
        ...clients.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claims").all().map(row => row.claim_id),
        ...clients.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts").all().map(row => row.receipt_id)];
      for (const id of raw) expect(json).not.toContain(id);
    }
    async function both(name: string, args: Record<string, unknown>) {
      const result = await clients.agent.call(name, args);
      expect(result.isError ?? false, name).toBe(false);
      const output = envelopeOf(result) as any; scan(output);
      const response = await fetch(`${server.url}/v1/${name}`, { method: "POST", headers: { authorization: `Bearer ${clients.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(args) });
      expect(response.status, name).toBe(200);
      const http = await response.json() as any; expect(http.ok, name).toBe(true); scan(http.value);
      seen.add(name); return output;
    }
    const entities = await both("query_entities", { type: "topic" });
    expect(entities.canon.length).toBeGreaterThan(0);
    const page = entities.canon.find((item: any) => item.title === "Scoped scan").page;
    await both("get_page", { page });
    await both("graph_neighbors", { anchor: page, depth: 1 });
    await both("search", { query: "Scoped scan" });
    const timeline = await both("timeline", {}), quoted = timeline.quoted[0];
    await both("context_packet", { purpose: "recall", budget_tokens: 2000 });
    await both("world_view", { operation: "describe" });
    const proposed = await both("propose", { kind: "claim", body: "Scoped preference for review.", subject: quoted.subjects[0], subjects: [quoted.subjects[0]], provenance: [quoted.eventVersion], predicate: "preference.prefers", object: { kind: "literal", value: "review" } });
    await both("correct", { statement: "Scoped preference for careful review.", target: proposed.data.claim, object: { kind: "literal", value: "careful review" } });
    const health = await clients.agent.call("system_health", {});
    expect(health.isError).toBe(true); scan(health);
    expect(JSON.parse(health.content[0]!.text)).toEqual({ error: "unsupported_contract", message: "requested contract unavailable", retry_after_seconds: null });
    const healthHttp = await fetch(`${server.url}/v1/system_health`, { method: "POST", headers: { authorization: `Bearer ${clients.agentToken}`, "content-type": "application/json" }, body: "{}" });
    expect(healthHttp.status).toBe(400); scan(await healthHttp.json()); seen.add("system_health");
    expect([...seen].sort()).toEqual([...TOOLS].sort());
    const initialized = h.runCli(env, "init", clients.vaultPath, "--no-service", "--no-default");
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const owner = (await clients.readConcept(clients.owner)).card as any;
    const target = owner.data.result.data.definitions[0].claim;
    const commands = [
      ["query", "Scoped", "--degraded", "--response-contract", V2],
      ["context", "--budget", "2000", "--purpose", "recall", "--response-contract", V2],
      ["tell", "A scoped updated definition.", `--world-claim=${target.token}`, "--response-contract", V2],
      ["world", "--operation", "describe"],
    ];
    for (const args of commands) {
      const output = h.runCli(env, "--vault", clients.vaultPath, ...args, "--json");
      expect(output.exitCode, `${args[0]}: ${output.stderr}`).toBe(0); scan(JSON.parse(output.stdout));
      // Text consumers must also use scoped generated labels, including replay.
      const text = h.runCli(env, "--vault", clients.vaultPath, ...args);
      expect(text.exitCode, text.stderr).toBe(0); scan(text.stdout);
    }
  } finally { await server.stop(); await clients.close(); h.cleanup(); }
}, 120_000);

test("well-formed references of the wrong kind have the same public refusal as absent targets", async () => {
  const clients = await twoClients({ agent: { tools: [...TOOLS], ceiling: "private", relay_owner_corrections: true, rate_limit_per_minute: 200 } });
  const server = startServeHttp({ db: clients.db, vaultPath: clients.vaultPath, host: "127.0.0.1", port: 0, token: "synthetic-ref-kind-control" });
  try {
    const timeline = envelopeOf(await clients.agent.call("timeline", {})) as any;
    const wrong = timeline.quoted[0].subjects[0];
    expect(wrong.kind).toBe("raw_subject");
    const absence = (kind: string) => ({ kind, token: "A".repeat(43) });
    const cases: Array<[string, (ref: unknown) => Record<string, unknown>, string]> = [
      ["get_page", ref => ({ page: ref }), "page"],
      ["search", ref => ({ query: "test", subjects: [ref] }), "raw_subject"],
      ["timeline", ref => ({ source: ref }), "source"],
      ["timeline", ref => ({ eventVersion: ref }), "event_version"],
      ["graph_neighbors", ref => ({ anchor: ref }), "page"],
      ["context_packet", ref => ({ subjects: [ref], purpose: "recall" }), "raw_subject"],
      ["propose", ref => ({ kind: "claim", body: "Unavailable target", provenance: [ref] }), "event_version"],
      ["correct", ref => ({ statement: "Unavailable correction", target: ref }), "claim"],
      ["world_view", ref => ({ operation: "observation", ref, valid: { kind: "all" }, knownAt: { kind: "current" } }), "observation"],
    ];
    for (const [name, args, expectedKind] of cases) {
      const responses = [];
      // Principal is well-formed but never an eligible target in these slots.
      for (const ref of [absence(expectedKind), timeline.principal]) {
        const input = args(ref);
        const mcp = await clients.agent.call(name, input);
        const http = await fetch(`${server.url}/v1/${name}`, { method: "POST", headers: { authorization: `Bearer ${clients.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(input) });
        const body = await http.json() as any;
        if (name === "world_view") {
          // Successful not_found envelopes carry the wall time of each call.
          // Compare every other envelope field and the complete fixed result.
          const { at: mcpAt, ...mcpValue } = envelopeOf(mcp);
          const { at: httpAt, ...httpValue } = body.value;
          expect(mcpAt).toBeString(); expect(httpAt).toBeString();
          expect(mcpValue.data).toEqual({ status: "not_found" });
          responses.push({ mcp: mcpValue, http: { status: http.status, ok: body.ok, value: httpValue } });
        } else responses.push({ mcp, http: { status: http.status, body } });
      }
      expect(responses[1], name).toEqual(responses[0]);
    }
  } finally { await server.stop(); await clients.close(); }
}, 120_000);
