import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, authorize, type Grant } from "../../src/agents";
import { citedSources } from "../../src/canon/citations";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { Claim } from "../../src/contracts/proposal";
import type { ProducerPort } from "../../src/contracts/producer";
import { registerConnection, setSourceGrant } from "../../src/index";
import { runBatch } from "../../src/ingest/run";
import { openLedger } from "../../src/ledger/db";
import { liveEventIds, readLiveEvent } from "../../src/ledger/ledger";
import { sourceEventsAllowed, sourceSensitivity } from "../../src/ledger/source-grants";
import { runRail } from "../../src/serve/rails";
import { pageScope, pageSnapshotDecision } from "../../src/serving/canon";
import { claimReader } from "../../src/serving/claims";
import { ulid } from "../../src/util/ulid";
import { initVault } from "../../src/vault/init";
import type { CanonPage } from "../../src/vault/pages";
import { listCanonPagesReport } from "../../src/vault/pages";
import { validEvent } from "../fixtures";

/**
 * A page is judged for a reader by the events it cites. With citations
 * bounded, the cited events must be ones the gate cannot tell from all of the
 * claim's live events: the same sources and fields, classes, origins and span.
 */

setDefaultTimeout(600_000);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.gate-test", kind: "producer", contract: "kizuki.producer/v1",
    contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
};
// A synthetic token in the shape the capture classifier marks as a credential.
const FAKE_KEY = "AKIA" + "Q".repeat(16);
const PAGE = "auto/fixture/person/ada.md";

function vault() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-citation-gate-"));
  roots.push(root);
  const path = join(root, "vault");
  initVault(path);
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

for (const plain of [99, 100]) {
  test(`an uncited credential or early event still decides the page for an agent (${plain} + 1 events)`, async () => {
    const { db, path } = vault();
    try {
      const events: CaptureEventInput[] = Array.from({ length: plain }, (_, index) => ({
        ...validEvent(), source_record_id: `a-${index}`, text: `Synthetic message ${index}.`, occurred_at: "2026-03-01T10:00:00Z",
      }));
      events.push({ ...validEvent(), source_record_id: "secret-1", text: `Synthetic note with a fake key ${FAKE_KEY}.`, occurred_at: "2025-01-01T10:00:00Z" });
      expect(runBatch(db, { events, cursor: null, has_more: false }, { page_candidates: false }, undefined, { vault_path: path }).errors).toEqual([]);
      const secret = db.query<{ event_id: string }, []>("SELECT event_id FROM events WHERE source_record_id='secret-1'").get()!.event_id;
      expect(db.query("SELECT class FROM event_classes WHERE event_id=?").all(secret)).toEqual([{ class: "credential" }]);
      expect((await runRail(db, path, "sync", { hooks: { producer, claims: { db }, model_ref: "kizuki.llm.synthetic:gate" } })).errors).toEqual([]);
      const page = listCanonPagesReport(path).pages.find((item) => item.relPath === PAGE)!;
      expect(page.data["sources"]).toContain(secret);
      expect(page.body).not.toContain(FAKE_KEY);

      const ctx = { db, vaultPath: path, principal: OWNER };
      const windowed: Grant = { ...OWNER_AGENT_GRANT, deny_classes: [], since: "2026-01-01T00:00:00Z" };
      const agent = pageSnapshotDecision(ctx, OWNER_AGENT_GRANT, page);
      const timed = pageSnapshotDecision(ctx, windowed, page);
      expect(agent).toMatchObject({ allow: false, reason: "class_denied" });
      expect(timed).toMatchObject({ allow: false, reason: "time_out_of_scope" });
      expect(pageSnapshotDecision(ctx, OWNER.grant, page).allow).toBe(true);

      // The claims route denies the same claim to both readers.
      const claim = db.query<{ claim_id: string }, []>("SELECT claim_id FROM claims WHERE kind='entity' AND status='live'").get()!;
      const stored = (await import("../../src/claims/store")).getClaim(db, claim.claim_id)!;
      for (const grant of [OWNER_AGENT_GRANT, windowed]) {
        expect(claimReader(db, grant, { owner: false, purpose: "recall" }).canRead(stored)).toBe(false);
      }
    } finally { db.close(); }
  });
}

/** Deterministic pseudo-random numbers, so a failing set can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const policy = (fields: string[], floor: string) => ({
  purposes: ["capture", "recall", "session", "derive", "extract", "export"],
  allowed_fields: fields, retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: floor,
});

test("for random event sets, every reader judges a page citing the chosen events as it would one citing all of them", () => {
  for (let round = 0; round < 8; round += 1) {
    const next = random(9_001 + round);
    const { db, path } = vault();
    try {
      // Three sources; one has a stricter floor, and one is later narrowed to drop metadata.
      const sources = [ulid(), ulid(), ulid()];
      const all = ["text", "subjects", "attachments", "metadata"];
      const policies = [policy(all, "personal"), policy(all, "personal"), policy(all, "private")];
      sources.forEach((source, index) => {
        registerConnection(db, "fixture", source);
        setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: `grant-${index}`, policy: policies[index]! });
      });
      // Mostly plain events, plus a few that alone carry an attribute the gate
      // judges: a class, a source, a field a grant later drops, a floor, an
      // extreme time. Each may land anywhere in provenance order, or be ended.
      type Shape = { source: number; text?: string; at?: string; metadata?: Record<string, string>; exhaust?: boolean };
      const specials: Shape[] = [
        { source: 0, text: `Synthetic key ${FAKE_KEY}.` },
        { source: 0, exhaust: true },
        { source: 1, metadata: { thread: "t-1" } },
        { source: 1, metadata: {} },
        { source: 2 },
        { source: 0, at: "2024-01-15T10:00:00Z" },
        { source: 0, at: "2026-12-15T10:00:00Z" },
      ];
      const shapes: Shape[] = Array.from({ length: 100 + Math.floor(next() * 120) }, () => ({ source: 0 }));
      for (const special of specials) {
        const copies = next() < 0.3 ? 0 : 1 + Math.floor(next() * 2);
        for (let copy = 0; copy < copies; copy += 1) shapes.splice(Math.floor(next() * shapes.length), 0, special);
      }
      const ids: string[] = [];
      for (const [index, shape] of shapes.entries()) {
        const event: CaptureEventInput = {
          ...validEvent(), source_record_id: `r-${index}`,
          text: shape.text ?? `Synthetic message ${index}.`,
          occurred_at: shape.at ?? `2025-${String(1 + (index % 12)).padStart(2, "0")}-15T10:00:00Z`,
          metadata: shape.metadata ?? { thread: `t-${index % 7}` },
          attachments: [],
        };
        expect(runBatch(db, { events: [event], cursor: null, has_more: false }, { page_candidates: false },
          { source_key: sources[shape.source]!, expected_revision: 1 }, { vault_path: path }).errors).toEqual([]);
        const id = db.query<{ event_id: string }, [string]>("SELECT event_id FROM events WHERE source_record_id=?").get(`r-${index}`)!.event_id;
        if (shape.exhaust === true) db.query("INSERT OR IGNORE INTO event_classes(event_id, class) VALUES (?, 'machine_exhaust')").run(id);
        ids.push(id);
        if (next() < 0.08) {
          expect(runBatch(db, { events: [{ ...event, deleted: true, text: "Synthetic deletion." }], cursor: null, has_more: false },
            { page_candidates: false }, { source_key: sources[shape.source]!, expected_revision: 1 }, { vault_path: path }).errors).toEqual([]);
        }
      }
      setSourceGrant(db, { source_key: sources[1]!, expected_revision: 1, operation_id: "narrow-1",
        policy: policy(["text", "subjects", "attachments"], "personal") });
      const order = ids.map((id) => [next(), id] as const).sort((a, b) => a[0] - b[0]).map(([, id]) => id);
      const claim = { provenance: order } as unknown as Claim;
      const live = order.filter((id) => liveEventIds(db, [id]).has(id));
      const cited = citedSources(db, [claim]);
      expect(cited.length).toBeLessThanOrEqual(100);
      expect(cited.every((id) => live.includes(id))).toBe(true);

      const windows = [
        { since: "2024-06-01T00:00:00Z", until: null }, { since: null, until: "2026-06-01T00:00:00Z" },
        { since: "2025-01-01T00:00:00Z", until: "2025-12-31T23:59:59Z" }, { since: "2023-01-01T00:00:00Z", until: "2027-01-01T00:00:00Z" },
      ];
      const readers: { grant: Grant; owner: boolean }[] = [
        { grant: OWNER.grant, owner: true },
        { grant: OWNER_AGENT_GRANT, owner: false },
        { grant: { ...OWNER_AGENT_GRANT, deny_classes: ["machine_exhaust"] }, owner: false },
        { grant: { ...OWNER_AGENT_GRANT, deny_classes: [] }, owner: false },
        { grant: { ...OWNER_AGENT_GRANT, ceiling: "personal" }, owner: false },
        ...windows.map((window) => ({ grant: { ...OWNER_AGENT_GRANT, deny_classes: [], ...window }, owner: false })),
      ];
      const page = (sources: readonly string[]): CanonPage => ({
        id: "page-1", path: join(path, PAGE), relPath: PAGE, body: "Referenced in a captured source.", contentHash: "0".repeat(64),
        data: { id: "page-1", type: "person", title: "ada", status: "active", sensitivity: "personal", taint: "quoted", sources: [...sources] },
      });
      const judge = (sources: readonly string[], reader: { grant: Grant; owner: boolean }) => {
        const ctx = { db, vaultPath: path, principal: OWNER };
        const label = sourceSensitivity(db, sources, "personal");
        const decision = authorize(reader.grant, { ...pageScope(ctx, page(sources), reader.grant), sensitivity: label });
        return {
          external: sources.every((id) => readLiveEvent(db, id)?.origin === "external"),
          allowed: sourceEventsAllowed(db, sources, { owner: reader.owner, purpose: "recall" }),
          label, allow: decision.allow, reason: decision.allow ? null : decision.reason,
        };
      };
      for (const reader of readers) expect({ round, ...judge(cited, reader) }).toEqual({ round, ...judge(live, reader) });
    } finally { db.close(); }
  }
});
