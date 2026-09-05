import { expect, test } from "bun:test";
import * as core from "@kizuki/core";
import * as publicSearch from "../../src/search";
import * as publicQuery from "../../src/query";
import { searchAuditCandidates } from "../../src/search/query";
import { timelineAuditCandidates } from "../../src/query/timeline";

test("audit query helpers are absent from every public query export", () => {
  for (const api of [core, publicSearch, publicQuery]) {
    expect(api).not.toHaveProperty("searchAuditCandidates");
    expect(api).not.toHaveProperty("timelineAuditCandidates");
    expect(api).not.toHaveProperty("requireCeiling");
  }
});

test("search audit candidates retain bounded rank/filter order without projecting content", () => {
  const db = core.openLedger(":memory:");
  try {
    core.initSearch(db);
    for (const [n, sensitivity] of [[1, "private"], [2, "public"], [3, undefined], [4, "personal"]] as const) {
      core.indexPage(db, {
        id: `fact:${n}`, path: `facts/${n}.md`, relPath: `facts/${n}.md`, contentHash: "0".repeat(64),
        data: { id: `fact:${n}`, type: "fact", title: "PRIVATE_AUDIT_TITLE_CANARY", status: "active", sensitivity },
        body: "ceilingaudit PRIVATE_AUDIT_BODY_CANARY",
      });
    }
    const sql: string[] = [];
    const readDb = { query: (query: string) => { sql.push(query); return db.query(query); } } as typeof db;
    const result = searchAuditCandidates(readDb, "ceilingaudit", { scope: "canon", types: ["fact"], limit: 2, excludePaths: ["facts/2.md"] });
    expect(result).toEqual({ candidates: [{ doc_id: "page:fact:1", scope: "canon" }, { doc_id: "page:fact:3", scope: "canon" }], degraded: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_AUDIT_");
    const projection = sql.find(query => query.includes("FROM search_docs"))!;
    expect(projection.startsWith("SELECT doc_id, scope ")).toBe(true);
    expect(projection).not.toMatch(/\b(?:body|title|snippet|text_preview)\b/);
    expect(projection).toContain("LIMIT ?");
    expect(searchAuditCandidates(readDb, "ceilingaudit", { limit: 0 }).candidates).toEqual([]);
  } finally { db.close(); }
});

test("timeline audit candidates keep time/filter/limit order and retrieve identities only", () => {
  const db = core.openLedger(":memory:");
  try {
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) {
      const result = core.accept(db, {
        schema: "kizuki.event/v1", connector_id: "synthetic", source_record_id: `audit:${n}`, kind: n === 1 ? "other" : "message",
        occurred_at: `2026-01-0${n + 1}T00:00:00Z`, observed_at: "2026-02-01T00:00:00Z", text: "PRIVATE_AUDIT_PREVIEW_CANARY",
        subjects: [{ subject_id: "person:synthetic", role: "from" }], sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
      });
      if (result.status !== "stored") throw Error("synthetic event must be accepted");
      ids.push(result.event.event_id);
      if (n === 2) db.query("UPDATE events SET sensitivity_hint = NULL WHERE event_id = ?").run(result.event.event_id);
    }
    const sql: string[] = [];
    const readDb = { query: (query: string) => { sql.push(query); return db.query(query); } } as typeof db;
    const result = timelineAuditCandidates(readDb, { kind: "message", since: "2026-01-01T00:00:00Z", until: "2026-01-04T00:00:00Z", limit: 2 });
    expect(result).toEqual([ids[0]!, ids[2]!]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_AUDIT_");
    expect(sql).toHaveLength(1); expect(sql[0]!.startsWith("SELECT event_id ")).toBe(true);
    expect(sql[0]).not.toMatch(/\b(?:text|text_preview|subjects|sensitivity_hint)\b/);
    expect(timelineAuditCandidates(readDb, { limit: 0 })).toEqual([]);
    expect(sql).toHaveLength(1);
  } finally { db.close(); }
});
