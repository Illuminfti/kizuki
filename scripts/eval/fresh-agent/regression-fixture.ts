// Subprocess-only regression driver: never change the shared test runner's Date.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { installLogicalClock } from "./clock";
import { AS_OF } from "./persona";

const [mode, root, hostTime] = process.argv.slice(2);
if (root === undefined) throw new Error("fixture root required");
installLogicalClock(mode === "host" ? hostTime! : AS_OF);
const { runEvaluation, observe, packetObservation, summarize, evaluationExitCode } = await import("./run");
const { OWNER, listAudit, shapeArguments, listClaims, listCanonReceipts, serveContextPacket } = await import("../../../packages/core/src/index");
const { openLedger } = await import("../../../packages/core/src/testing");

if (mode === "host") {
  const report = await runEvaluation({ size: "small", out: root });
  const db = openLedger(join(root, "vault", ".kizuki", "kizuki.db"));
  try {
    const corrections = listClaims(db).filter(claim => claim.authority === "owner_correction")
      .map(claim => ({ created_at: claim.created_at, asserted_at: claim.asserted_at, valid_from: claim.valid_from }));
    const receipts = listCanonReceipts(db).map(receipt => receipt.at);
    // Hook v2 packets omit request time. The receipt still proves the hook
    // ran on the evaluation clock, for both owner and token principals.
    const sessionPurpose = JSON.stringify(shapeArguments({ purpose: "session" }).purpose);
    const hookAudit = Object.fromEntries(["owner", "fresh-agent"].map(name => [name,
      listAudit(db, name, { kind: "access", limit: 500 })
        .filter(row => row.tool === "context_packet" && JSON.stringify(row.query_shape.purpose) === sessionPurpose)
        .map(row => row.at),
    ]));
    writeFileSync(join(root, "regression.json"), JSON.stringify({ report, corrections, receipts, hook_audit: hookAudit, caller_time: new Date().toISOString() }));
  } finally { db.close(); }
  process.exit(0);
} else if (mode === "unavailable") {
  const { generateVault } = await import("./vault");
  const { scoreObservation } = await import("./score");
  const fixture = await generateVault(root, "small");
  let exitCode: 0 | 1;
  try {
    const question = fixture.questions.find(question => question.id === "now")!;
    const ctx = { db: fixture.db, vaultPath: fixture.vaultPath, principal: OWNER };
    const fallback = await serveContextPacket({ ...ctx, retrievalUnavailable: true }, { query: question.query, purpose: "recall", budget_tokens: 2000 });
    const { data, ...noData } = fallback;
    const statuses = [packetObservation(noData).status,
      packetObservation({ ...fallback, data: { ...data!, packet_md: "", truncated: true } }).status,
      packetObservation(fallback).status,
      packetObservation({ ...fallback, data: { ...data!, truncated: true } }).status];
    // A broken deterministic floor produces Core's real context-unavailable envelope.
    fixture.db.exec("DROP TABLE search_docs; CREATE TABLE search_docs (broken TEXT)");
    const observation = await observe(fixture, "owner", "context_packet", question, root);
    const summaries = summarize([scoreObservation(fixture.facts, question, "owner", "context_packet", observation)]);
    writeFileSync(join(root, "regression.json"), JSON.stringify({ statuses, fallback, observation, summaries }));
    exitCode = evaluationExitCode({ summaries });
  } finally { fixture.db.close(); }
  process.exit(exitCode);
} else {
  throw new Error("unknown fixture mode");
}
