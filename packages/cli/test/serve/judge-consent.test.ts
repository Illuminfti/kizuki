import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, ConnectionStateStore, registerConnection, setSourceGrant, sourcePolicyEpoch, ulid, type ProducerPort, type ProducerV2Port } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { commitExtractCursor, mineLiveDrafts, readExtractCursor } from "../../../core/src/serve/extract";
import { sourceEventsAllowed } from "../../../core/src/ledger/source-grants";
import { validEvent } from "../../../core/test/fixtures";
import { startFakeEndpoint, defaultChatCompletion } from "../../../llm/test/fake-endpoint";
import { createServeRuntime } from "../../src/serve-runtime";
import { createHelpers } from "../helpers";

const { tempVault, cleanup } = createHelpers();
afterEach(cleanup);

test("epoch-zero serve holds extraction for an unconsented judge without advancing the cursor", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const accepted = accept(db, { ...validEvent(), text: "Ada joined the orchard library project." });
  if (accepted.status !== "stored") throw new Error("fixture capture failed");
  const server = startFakeEndpoint(request => {
    if (request.path === "/v1/systemone") {
      return Response.json({ model: "synthetic-judge", answers: { admit_0: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 2 } });
    }
    expect(request.path).toBe("/v1/chat/completions");
    return defaultChatCompletion(JSON.stringify({ claims: [{
      kind: "claim", subject: "person:ada", predicate: "employment.role", object: "orchard library collaborator",
      polarity: "positive", body: "Ada is an orchard library collaborator.", valid_from: null, valid_to: null,
      confidence: 0.8, sensitivity: "personal", event_ids: [accepted.event.event_id],
    }] }));
  });
  let runtime: Awaited<ReturnType<typeof createServeRuntime>> | undefined;
  const config = `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${server.base_url}"\nmodel = "synthetic-model"\n`;
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  const bind = () => createServeRuntime({ db, vaultPath: setup.vault, store: new ConnectionStateStore(join(setup.vault, ".kizuki")), env: setup.env, err: () => {} });
  try {
    expect(sourcePolicyEpoch(db)).toBe(0);
    writeFileSync(configPath, `${config}[ports.systemone]\nid = "kizuki.systemone.jev"\nbase_url = "${server.base_url}"\nmodel = "synthetic-judge"\n`, { mode: 0o600 });
    runtime = await bind();
    const producer = runtime.hooks.producer as ProducerPort;
    expect(producer.descriptor.contract).toBe("kizuki.producer/v1");
    expect(sourceEventsAllowed(db, [accepted.event.event_id], { owner: false, purpose: "extract", model: true, port: producer })).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const held = await mineLiveDrafts(db, producer);
      expect(held.mined).toEqual({ status: "unavailable", reason: "source authorization unavailable" });
      expect(held.drafts).toEqual([]);
      expect(held.cursor).toBeNull();
      expect(commitExtractCursor(db, held)).toBe(false);
      expect(readExtractCursor(db)).toBeNull();
      expect(server.requests).toHaveLength(0);
    }
    await runtime.close(); runtime = undefined;
    // The historical model-only route still extracts the valid fixture.
    writeFileSync(configPath, config, { mode: 0o600 });
    runtime = await bind();
    const mined = await mineLiveDrafts(db, runtime.hooks.producer as ProducerPort);
    expect(mined.mined.status).toBe("ok");
    expect(mined.drafts).toHaveLength(1);
    expect(server.requests.map(request => request.path)).toEqual(["/v1/chat/completions"]);
  } finally {
    try { await runtime?.close(); } finally { server.stop(); db.close(); }
  }
}, 120_000);

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
