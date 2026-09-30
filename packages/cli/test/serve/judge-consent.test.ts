import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, ConnectionStateStore, registerConnection, setSourceGrant, ulid, type ProducerV2Port } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { mineLiveDrafts } from "../../../core/src/serve/extract";
import { sourceEventsAllowed } from "../../../core/src/ledger/source-grants";
import { validEvent } from "../../../core/test/fixtures";
import { startFakeEndpoint, defaultChatCompletion } from "../../../llm/test/fake-endpoint";
import { createServeRuntime } from "../../src/serve-runtime";
import { createHelpers } from "../helpers";

const { tempVault, cleanup } = createHelpers();
afterEach(cleanup);

test("serve binds distinct chat and judge destinations and sends only events consented for both", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const server = startFakeEndpoint(request => {
    if (request.path === "/v1/systemone") {
      return Response.json({ model: "synthetic-judge", answers: { admit_0: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 2 } });
    }
    expect(request.path).toBe("/v1/chat/completions");
    const body = request.body as { messages: { content: string }[] };
    const eventId = /event:([0-9A-HJKMNP-TV-Z]{26})/.exec(body.messages[1]!.content)![1]!;
    const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 3 };
    return defaultChatCompletion(JSON.stringify({
      schema: "kizuki.producer-response/v2",
      mentions: [{ id: "m0", label: "Ada", anchor, candidate_refs: [] }],
      claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "employment.role",
        object: { kind: "literal", value: "orchard library collaborator" },
        perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
        context: [], polarity: "positive", body: "Ada is an orchard library collaborator.",
        valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "private", anchors: [anchor] }],
    }));
  });
  let runtime: Awaited<ReturnType<typeof createServeRuntime>> | undefined;
  try {
    const source = ulid();
    registerConnection(db, "kizuki.fixture", source);
    const egress = { model_endpoint: `${server.base_url}/chat/completions`, model: "synthetic-model", external_retention: "provider_managed" as const };
    const policy = { purposes: ["capture", "recall", "derive", "extract"] as const,
      allowed_fields: ["text", "subjects", "attachments", "metadata"] as const,
      retention: "persistent_owned_until_revoked" as const, sensitivity_floor: "private" as const };
    const grant = (revision: number, judge = false) => setSourceGrant(db, {
      source_key: source, expected_revision: revision, operation_id: `grant-${revision}`,
      policy: { ...policy, purposes: [...policy.purposes], allowed_fields: [...policy.allowed_fields],
        egress: { ...egress, ...(judge ? { judge_endpoint: `${server.base_url}/systemone`, judge_model: "synthetic-judge" } : {}) } },
    });
    grant(0);
    const accepted = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", text: "Ada joined the orchard library project." },
      { source: { source_key: source, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("fixture capture failed");
    writeFileSync(join(setup.vault, ".kizuki", "serve.toml"),
      `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${server.base_url}"\nmodel = "synthetic-model"\n[ports.systemone]\nid = "kizuki.systemone.jev"\nbase_url = "${server.base_url}"\nmodel = "synthetic-judge"\n`, { mode: 0o600 });
    runtime = await createServeRuntime({ db, vaultPath: setup.vault, store: new ConnectionStateStore(join(setup.vault, ".kizuki")), env: setup.env, err: () => {} });
    const producer = runtime.hooks.producer as ProducerV2Port;
    const scope = { owner: false, purpose: "extract" as const, model: true, port: producer };
    expect(sourceEventsAllowed(db, [accepted.event.event_id], scope)).toBe(false);
    const held = await mineLiveDrafts(db, producer);
    expect(held.mined.status).toBe("deferred");
    expect(held.drafts).toEqual([]);
    expect(server.requests).toHaveLength(0);

    grant(1, true);
    expect(sourceEventsAllowed(db, [accepted.event.event_id], scope)).toBe(true);
    const mined = await mineLiveDrafts(db, producer);
    expect(mined.mined.status).toBe("ok");
    expect(server.requests.map(request => request.path)).toEqual(["/v1/chat/completions", "/v1/systemone"]);
    expect(mined.world?.response.claims).toHaveLength(1);
  } finally {
    try { await runtime?.close(); } finally { server.stop(); db.close(); }
  }
}, 120_000);
