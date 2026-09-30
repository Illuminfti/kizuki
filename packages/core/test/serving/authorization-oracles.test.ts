import { expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { correct } from "../../src/correction/correct";
import { getClaim, insertClaim } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { serveCorrect } from "../../src/serving/correct";
import { serveEntities } from "../../src/serving/entities";
import { serveGraph } from "../../src/serving/graph";
import { servePropose } from "../../src/serving/propose";
import { serveSearch } from "../../src/serving/search";
import { serveContextPacket } from "../../src/serving/packet";
import { serveWorldView } from "../../src/serving/world-view";
import { temporaryPortContext } from "../contracts/fixtures";
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { claimInput } from "../claims/helpers";
import { enrollSource, worldSeed } from "../helpers/world-seed";
import { recordedPage, serveFixture } from "./helpers";

const proposal = (event: string) => ({
  kind: "claim" as const, target: "facts:exact", body: "Ada lives in Lisbon.",
  subject: "person:ada", subjects: ["person:ada"], predicate: "location.based_in",
  object: "Lisbon", provenance: [event], confidence: 0.5,
});

test("exact proposal collisions with hidden claims neither leak nor fail and retries stay idempotent", async () => {
  const f = await serveFixture();
  try {
    const args = proposal(f.events.public!);
    const hidden = await insertClaim({ db: f.db }, claimInput(f.events.private!, {
      ...args, provenance: [f.events.private!], sensitivity: "private",
    }));
    if (hidden.outcome !== "stored") throw new Error(hidden.outcome);
    const before = getClaim(f.db, hidden.claim.claim_id);
    const first = await servePropose(f.agent("reader-public"), args);
    expect(first.data?.outcome).toBe("stored");
    expect(first.data?.claim_id).not.toBe(hidden.claim.claim_id);
    expect(getClaim(f.db, hidden.claim.claim_id)).toEqual(before);
    const again = await servePropose(f.agent("reader-public"), args);
    expect(again.data).toEqual({ ...first.data!, outcome: "duplicate" });
  } finally { f.dispose(); }
});

test("a hidden higher-authority rival cannot refuse a correction or be retired", async () => {
  const f = await serveFixture();
  try {
    const open = await insertClaim({ db: f.db }, claimInput(f.events.public!, {
      subject: "person:ada", predicate: "employment.works_at", object: "Acme",
      sensitivity: "public", body: "Ada works at Acme.",
    }));
    if (open.outcome !== "stored") throw new Error(open.outcome);
    const hidden = await insertClaim({ db: f.db }, claimInput(f.events.private!, {
      subject: "person:ada", predicate: "employment.works_at", object: "Secret org",
      sensitivity: "private", body: "Ada works at Secret org.",
    }));
    const hiddenId = hidden.outcome === "contested" ? hidden.incoming.claim_id : hidden.claim.claim_id;
    // Model an already recorded owner correction without changing the visible target.
    f.db.query("UPDATE claims SET authority='owner_correction' WHERE claim_id=?").run(hiddenId);
    const relay = addAgent(f.db, "scoped-relay", {
      ...OWNER_AGENT_GRANT, ceiling: "public", tools: ["correct"], relay_owner_corrections: false,
    });
    const answer = await serveCorrect({ ...f.owner(), principal: authenticate(f.db, relay.token)! }, {
      statement: "Ada works at Globex.", target: { claim_id: open.claim.claim_id }, object: "Globex",
    });
    expect(answer.data?.superseded.map(item => item.claim_id)).toEqual([open.claim.claim_id]);
    expect(getClaim(f.db, hiddenId)?.status).toBe("live");
    expect(JSON.stringify(answer)).not.toContain(hiddenId);
  } finally { f.dispose(); }
});

test("source permission for derivation does not make unreadable claims write candidates", async () => {
  const f = await serveFixture();
  try {
    const source = enrollSource(f.db, "scoped.fixture", "public");
    const event = accept(f.db, {
      schema: "kizuki.event/v1", connector_id: "scoped.fixture", source_record_id: "record",
      kind: "note", occurred_at: "2026-02-28T10:00:00Z", observed_at: "2026-03-01T00:00:00Z",
      text: "Ada lives in Lisbon.", subjects: [{ subject_id: "person:ada", role: "about" }],
      sensitivity_hint: "public", deleted: false, attachments: [], metadata: {},
    }, { source: { source_key: source, expected_revision: 1 } });
    if (event.status !== "stored") throw new Error(event.status);
    const hidden = await insertClaim({ db: f.db }, claimInput(event.event.event_id, {
      ...proposal(event.event.event_id), sensitivity: "public",
    }));
    if (hidden.outcome !== "stored") throw new Error(hidden.outcome);
    setSourceGrant(f.db, { source_key: source, expected_revision: 1, operation_id: "derive-only", policy: {
      purposes: ["capture", "derive", "correction"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
    } });
    const visible = enrollSource(f.db, "readable.fixture", "public");
    const incoming = accept(f.db, {
      schema: "kizuki.event/v1", connector_id: "readable.fixture", source_record_id: "incoming",
      kind: "note", occurred_at: "2026-02-28T11:00:00Z", observed_at: "2026-03-01T00:00:00Z",
      text: "New evidence.", subjects: [{ subject_id: "person:ada", role: "about" }],
      sensitivity_hint: "public", deleted: false, attachments: [], metadata: {},
    },
      { source: { source_key: visible, expected_revision: 1 } });
    if (incoming.status !== "stored") throw new Error(incoming.status);
    const before = getClaim(f.db, hidden.claim.claim_id);
    const answer = await servePropose(f.agent("reader-public"), proposal(incoming.event.event_id));
    expect(answer.data?.outcome).toBe("stored");
    expect(JSON.stringify(answer)).not.toContain(hidden.claim.claim_id);
    expect(getClaim(f.db, hidden.claim.claim_id)).toEqual(before);
    const corrected = await serveCorrect(f.agent("reader-public"), {
      statement: "Ada lives in Paris.", target: { claim_id: answer.data!.claim_id }, object: "Paris",
    });
    expect(corrected.data?.superseded.map(item => item.claim_id)).toEqual([answer.data!.claim_id]);
    expect(JSON.stringify(corrected)).not.toContain(hidden.claim.claim_id);
    expect(getClaim(f.db, hidden.claim.claim_id)).toEqual(before);
  } finally { f.dispose(); }
});

test("entity name matching cannot probe a redacted title or handle", async () => {
  const f = await serveFixture();
  try {
    const value = ["sk", "-", "fixture", "x".repeat(24)].join("");
    await recordedPage(f.db, f.vaultPath, "entities/credential-label.md", {
      id: "person:credential-label", title: value, "x-handle": value, type: "person",
      status: "active", sensitivity: "public", taint: "clean", subjects: ["person:ada"],
    }, "A synthetic entity.", [f.events.public!]);
    expect(serveEntities(f.owner(), { name: "fixturexxx" }).canon).toHaveLength(1);
    const answer = serveEntities(f.agent("reader-public"), { name: "fixturexxx" });
    expect(answer.canon).toEqual([]);
    expect(answer.redacted).toBeUndefined();
    expect(serveEntities(f.agent("reader-public"), { name: "redacted" }).canon).toHaveLength(1);
  } finally { f.dispose(); }
});

test("canon search and packets drop matches found only in redacted text", async () => {
  const f = await serveFixture();
  try {
    const value = ["sk", "-", "fixture", "x".repeat(24)].join("");
    await recordedPage(f.db, f.vaultPath, "facts/redacted-search.md", {
      id: "fact:redacted-search", title: value, type: "fact", status: "active",
      sensitivity: "public", taint: "clean", subjects: ["person:ada"],
    }, "A synthetic searchable note.", [f.events.public!]);
    expect((await serveSearch(f.owner(), { query: "fixturexxx*" })).canon).toHaveLength(1);
    const answer = await serveSearch(f.agent("reader-public"), { query: "fixturexxx*" });
    expect(answer.canon).toEqual([]);
    expect(answer.redacted).toBeUndefined();
    const packet = await serveContextPacket(f.agent("reader-public"), { query: "fixturexxx*", include: ["canon"] });
    expect(packet.canon).toEqual([]);
    expect(packet.redacted).toBeUndefined();
    const readable = await serveSearch(f.agent("reader-public"), { query: "synthetic searchable" });
    expect(readable.canon.map(item => item.page_id)).toEqual(["fact:redacted-search"]);
    expect(readable.canon[0]?.title).toBe("[redacted:api_token]");
  } finally { f.dispose(); }
});

test("world discovery matches served labels", async () => {
  const f = await serveFixture();
  try {
    const value = ["sk", "-", "fixture", "x".repeat(24)].join("");
    await worldSeed(f.db, { label: value });
    const query = { operation: "find_concepts", label: "fixturexxx", valid: { kind: "all" }, knownAt: { kind: "current" } };
    const owner = serveWorldView(f.owner(), query);
    expect(JSON.stringify(owner)).toContain(value);
    const agent = serveWorldView(f.agent("reader-public"), query);
    expect(agent.data).toMatchObject({ result: { data: { matches: [] } } });
    expect(agent.redacted).toBeUndefined();
    expect(serveWorldView(f.agent("reader-public"), { ...query, label: "redacted" }).data)
      .toMatchObject({ result: { data: { matches: [{ labels: ["[redacted:api_token]"] }] } } });
  } finally { f.dispose(); }
});

test("hidden subject-scoped graph edges neither crowd out visible edges nor set truncation", async () => {
  const f = await serveFixture();
  try {
    const before = await serveGraph(f.agent("subjected"), { id: "person:ada", kinds: ["subject"], depth: 2 });
    for (let index = 0; index < 101; index++) {
      await recordedPage(f.db, f.vaultPath, `facts/hidden-${index}.md`, {
        id: `fact:a-hidden-${index}`, title: "Hidden relation", type: "fact", status: "active",
        sensitivity: "public", taint: "clean", subjects: ["person:grace"],
      }, "An unrelated relation.", [f.events.public!]);
      f.db.query("INSERT INTO graph_edges(src,dst,kind,sensitivity,dest_sensitivity,taint,authority,provenance) VALUES (?,?,'subject','public',NULL,'clean','connector_evidence',?)")
        .run(`fact:a-hidden-${index}`, "person:ada", JSON.stringify([f.events.public!]));
    }
    const after = await serveGraph(f.agent("subjected"), { id: "person:ada", kinds: ["subject"], depth: 2 });
    expect(after.data).toEqual(before.data);
    expect(after.data?.truncated).toBe(false);
  } finally { f.dispose(); }
});

test("a provider's hidden overflow does not set graph truncation", async () => {
  const f = await serveFixture();
  const descriptor = { ...DIRECT_RETRIEVAL_DESCRIPTOR, supports: ["lexical", "graph"] as const };
  const temporary = temporaryPortContext(descriptor);
  const retrieval = new ReferenceRetrievalPort(temporary.ctx, descriptor);
  retrieval.neighbors = async entity => ({
    entity: entity.entity_id, truncated: true,
    edges: [{ from: "fact:linked", to: "person:grace", type: "wikilink", weight: 1, provenance: [] }],
  });
  try {
    const ctx = f.agent("reader-public");
    const before = await serveGraph(ctx, { id: "fact:linked" });
    const after = await serveGraph({ ...ctx, retrieval }, { id: "fact:linked" });
    expect(after.data).toEqual(before.data);
    expect(after.data?.truncated).toBe(false);
  } finally { f.dispose(); temporary.cleanup(); }
});


test("the shared correction writer also excludes hidden peers", async () => {
  const f = await serveFixture();
  try {
    const open = await insertClaim({ db: f.db }, claimInput(f.events.public!, {
      subject: "person:ada", predicate: "employment.works_at", object: "Acme", body: "Ada works at Acme.", sensitivity: "public",
    }));
    if (open.outcome !== "stored") throw new Error(open.outcome);
    const hidden = await insertClaim({ db: f.db }, claimInput(f.events.private!, {
      subject: "person:ada", predicate: "employment.works_at", object: "Private org", body: "Ada works at Private org.", sensitivity: "private",
    }));
    const hiddenId = hidden.outcome === "contested" ? hidden.incoming.claim_id : hidden.claim.claim_id;
    const before = getClaim(f.db, hiddenId);
    const answer = await correct({ db: f.db, vault_path: f.vaultPath, producer: "agent:reader-public", grant: f.agent("reader-public").principal.grant },
      { statement: "Ada works at Globex.", target: { claim_id: open.claim.claim_id } });
    expect(answer.superseded.map(item => item.claim_id)).toEqual([open.claim.claim_id]);
    expect(getClaim(f.db, hiddenId)).toEqual(before);
    expect(JSON.stringify(answer)).not.toContain(hiddenId);
  } finally { f.dispose(); }
});
