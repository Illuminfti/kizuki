import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OWNER, OWNER_AGENT_GRANT, authorize, type Grant } from "../../src/agents";
import { initPageClasses } from "../../src/canon/page-classes";
import { pageScope, pageSnapshotDecision } from "../../src/serving/canon";
import type { ServeContext } from "../../src/serving/types";
import type { CanonPage } from "../../src/vault/pages";
import { openLedger } from "../../src/ledger/db";
import { listCanonPagesReport } from "../../src/vault/pages";
import * as provenance from "../../src/vault/provenance";
import { seedLivePages } from "../helpers/bulk-pages";
import { tempVault } from "../helpers/vault";

function scopeFixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events(event_id TEXT PRIMARY KEY, occurred_at TEXT); CREATE TABLE event_classes(event_id TEXT, class TEXT)");
  db.query("INSERT INTO events VALUES (?, ?)").run("source", "2026-01-01T12:00:00Z");
  initPageClasses(db);
  const page: CanonPage = { id: "page", path: "facts/page.md", relPath: "facts/page.md", contentHash: "fixture-hash", body: "plain note", data: {
    type: "fact", sensitivity: "personal", sources: ["source"], subjects: ["person:fixture"],
  } };
  const ctx: ServeContext = { db, vaultPath: "fixture", principal: OWNER };
  return { db, page, ctx };
}

for (const count of [401, 801]) test(`unrestricted grant avoids unused policy reads across ${count} page scopes`, () => {
  const { db, page, ctx } = scopeFixture();
  const query = spyOn(db, "query");
  try {
    for (let id = 0; id < count; id++) {
      const scope = pageScope(ctx, { ...page, id: `page-${id}` }, OWNER.grant);
      expect(authorize(OWNER.grant, scope)).toEqual({ allow: true });
    }
    expect(query).not.toHaveBeenCalled();
  } finally { query.mockRestore(); db.close(); }
});

test("generic scope remains complete and an explicit grant controls class and time dimensions", () => {
  const { db, page, ctx } = scopeFixture();
  try {
    db.query("INSERT INTO event_classes VALUES (?, ?)").run("source", "credential");
    const full = pageScope(ctx, page);
    expect(full.classes).toEqual(["credential"]);
    expect(full.occurred_span).toEqual({ from: "2026-01-01T12:00:00Z", to: "2026-01-01T12:00:00Z" });
    const defaultDenied = { ...OWNER_AGENT_GRANT, ceiling: "private" } as Grant;
    expect(authorize(defaultDenied, pageScope(ctx, page, defaultDenied))).toEqual({ allow: false, reason: "class_denied" });
    const windowed = { ...OWNER.grant, since: "2026-01-02T00:00:00Z" };
    expect(authorize(windowed, pageScope(ctx, page, windowed))).toEqual({ allow: false, reason: "time_out_of_scope" });
    expect(pageScope(ctx, page, OWNER.grant)).not.toHaveProperty("occurred_span");
    expect(authorize(OWNER.grant, pageScope(ctx, page, OWNER.grant))).toEqual({ allow: true });
    const wrongType = { ...OWNER.grant, types: ["person"] };
    expect(authorize(wrongType, pageScope(ctx, page, wrongType))).toEqual({ allow: false, reason: "type_out_of_scope" });
  } finally { db.close(); }
});

test("a newly requested time window and changed source classes remain live", () => {
  const { db, page, ctx } = scopeFixture();
  try {
    expect(authorize(OWNER.grant, pageScope(ctx, page, OWNER.grant))).toEqual({ allow: true });
    const windowed = { ...OWNER.grant, since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" };
    expect(authorize(windowed, pageScope(ctx, page, windowed))).toEqual({ allow: true });
    db.query("UPDATE events SET occurred_at=?").run("2026-01-03T00:00:00Z");
    expect(authorize(windowed, pageScope(ctx, page, windowed))).toEqual({ allow: false, reason: "time_out_of_scope" });
    const classed = { ...OWNER.grant, deny_classes: ["credential"] } as Grant;
    expect(authorize(classed, pageScope(ctx, page, classed))).toEqual({ allow: true });
    db.query("INSERT INTO event_classes VALUES (?, ?)").run("source", "credential");
    expect(authorize(classed, pageScope(ctx, page, classed))).toEqual({ allow: false, reason: "class_denied" });
  } finally { db.close(); }
});

test("one-sided windows reject missing, malformed and out-of-window source timestamps", () => {
  const { db, page, ctx } = scopeFixture();
  try {
    const since = { ...OWNER.grant, since: "2026-01-01T13:00:00Z" };
    const until = { ...OWNER.grant, until: "2026-01-01T11:00:00Z" };
    for (const grant of [since, until]) {
      expect(authorize(grant, pageScope(ctx, page, grant))).toEqual({ allow: false, reason: "time_out_of_scope" });
    }
    db.query("UPDATE events SET occurred_at=?").run("invalid fixture timestamp");
    expect(authorize(since, pageScope(ctx, page, since))).toEqual({ allow: false, reason: "time_out_of_scope" });
    db.query("DELETE FROM events").run();
    expect(authorize(until, pageScope(ctx, page, until))).toEqual({ allow: false, reason: "time_out_of_scope" });
  } finally { db.close(); }
});

for (const changed of ["time", "class"] as const) test(`final page decision rechecks ${changed} after evidence resolution`, () => {
  const vault = tempVault();
  const db = openLedger(":memory:");
  const realAssess = provenance.assessLivePageEvidence;
  try {
    const [seed, other] = seedLivePages(db, vault.path, 2);
    const page = listCanonPagesReport(vault.path).pages[0]!;
    const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
    const grant: Grant = changed === "time"
      ? { ...OWNER.grant, since: "2000-01-01T00:00:00Z" }
      : { ...OWNER.grant, deny_classes: ["credential"] };
    const assess = spyOn(provenance, "assessLivePageEvidence").mockImplementation((...args) => {
      const evidence = realAssess(...args);
      expect(evidence.admitted).toBe(true);
      if (changed === "time") db.query("DELETE FROM events WHERE event_id=?").run(seed!.sourceId);
      else db.query("INSERT INTO event_classes VALUES (?, ?)").run(seed!.sourceId, "credential");
      // A changed in-memory page cannot substitute a different, still-readable
      // source for the evidence already admitted by this decision.
      page.data.sources = [other!.sourceId];
      return evidence;
    });
    try {
      expect(pageSnapshotDecision(ctx, grant, page)).toEqual({ allow: false, reason: changed === "time" ? "time_out_of_scope" : "class_denied" });
    } finally { assess.mockRestore(); }
  } finally { db.close(); vault.dispose(); }
});
