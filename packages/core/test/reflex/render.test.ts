import { test } from "node:test";
import * as assert from "node:assert/strict";
import { renderReflexHtml } from "../../src/reflex/render";
import { syntheticReflexReport } from "./demo-fixture";

test("report exposes a navigable matrix, source lineage, and an explicit advisory boundary", async () => {
  const report = await syntheticReflexReport(); const html = renderReflexHtml(report, { demo: true });
  assert.equal(report.matrix.length, 9);
  assert.deepEqual(report.findings.map(f => f.verdict), ["conflicted", "unknown", "supported"]);
  for (const marker of ["Not an execution permit", "Synthetic demo", "scope=\"row\"", "id=\"source-0\"", "href=\"#source-0\"", "Content-Security-Policy", "saved copies do not participate in vault purge"]) assert.ok(html.includes(marker), marker);
  assert.ok(!html.includes("<script")); assert.ok(!html.includes("https://")); assert.ok(!html.includes("src="));
  assert.ok(!html.includes("The campaign is approved for Friday."));
});
test("HTML neutralizes hostile statements, source IDs, model labels, and forged metric strings", async () => {
  const report = await syntheticReflexReport();
  const hostile = '<img src=x onerror="alert(1)">\u001b[2J\u202etest';
  const html = renderReflexHtml({ ...report, model: hostile,
    findings: report.findings.map(f => ({ ...f, statement: hostile, next_step: hostile })),
    evidence: report.evidence.map(e => ({ ...e, event_id: hostile })),
    metrics: { ...report.metrics, input_tokens: hostile as unknown as number },
  });
  assert.ok(!html.includes("<img")); assert.ok(!html.includes("\u001b")); assert.ok(!html.includes("\u202e"));
  assert.ok(html.includes("&lt;img")); assert.ok(!html.includes("href=\"<"));
});
test("unavailable reports never label missing matrix cells as support", async () => {
  const report = await syntheticReflexReport();
  const html = renderReflexHtml({ ...report, status: "unavailable", reason: "timeout", matrix: [] });
  assert.ok(html.includes("Assessment unavailable")); assert.ok(html.includes("Not assessed"));
  assert.ok(html.includes("Do not treat missing results as approval"));
});
