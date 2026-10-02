import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cases, CORPUS_SIZE } from "./cases";
import { CI_SEED, runFuzz, TARGETS } from "./run";
import { supervise } from "./supervisor";
import { parseCase } from "./parsers";
import { OWNER_TOKEN, httpPost, httpTool, surfaceDriver } from "./surfaces";
import { OWNER_AGENT_GRANT, addAgent } from "../../packages/core/src/index";

const linuxTest = test.if(process.platform === "linux");

test("a generic HTTP serving failure fails the campaign instead of counting as refusal", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kizuki-fuzz-http-"));
  const driver = await surfaceDriver("http", scratch);
  try {
    const db = new Database(join(scratch, "vault/.kizuki/kizuki.db"));
    try { db.exec("DROP TABLE events"); } finally { db.close(); }
    const text = "{}";
    await expect(driver.run({ id: "synthetic", text, bytes: Buffer.from(text) })).rejects.toThrow("http-crash");
  } finally { await driver.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("an internal failure inside a successful HTTP envelope fails the campaign for the owner and for an agent", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kizuki-fuzz-http-"));
  const driver = await surfaceDriver("http", scratch);
  const db = new Database(join(scratch, "vault/.kizuki/kizuki.db"));
  try {
    const agent = addAgent(db, "synthetic-reader", { ...OWNER_AGENT_GRANT, tools: [...OWNER_AGENT_GRANT.tools] });
    db.exec("DROP TABLE events");
    const body = JSON.stringify({ purpose: "recall", budget_tokens: 1000 });
    const envelopeFor = async (token: string) => {
      const { status, text } = await httpPost(driver.httpOrigin!, "context_packet", body, token);
      expect(status).toBe(200);
      return JSON.parse(text) as { ok: boolean };
    };
    // The owner envelope reports the failure as an `error` denial.
    const owner = await envelopeFor(OWNER_TOKEN);
    expect(owner).toMatchObject({ ok: true, value: { denied: [{ reason: "error", count: 1 }] } });
    await expect(httpTool(driver.httpOrigin!, "context_packet", body)).rejects.toThrow("http-crash");
    // An agent envelope hides denials, so only the degradation names the failure.
    const reader = await envelopeFor(agent.token);
    expect(reader).toMatchObject({ ok: true, value: { denied: [], data: { retrieval_degraded: ["context-unavailable"] } } });
    await expect(httpTool(driver.httpOrigin!, "context_packet", body, agent.token)).rejects.toThrow("http-crash");
  } finally { db.close(); await driver.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("wrapped Gmail corpus reaches MIME body parsing and emits valid evidence", () => {
  const text = "synthetic MIME evidence";
  const event = parseCase("gmail", { id: "synthetic", text, bytes: Buffer.from(text) }, true);
  expect(event).toMatchObject({ text, kind: "email", sensitivity_hint: "private" });
});

test("wrapped Beacon corpus reaches event normalization", () => {
  const text = "synthetic prompt evidence";
  const result = parseCase("beacon", { id: "synthetic", text, bytes: Buffer.from(text) }, true) as { events: { text: string }[] };
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.text).toContain(text);
});

test("seed and corpus replay exactly", () => {
  const hashes = (seed: number) => [...cases(seed, 8)].map(input => [input.id, new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex")]);
  expect(hashes(CI_SEED)).toEqual(hashes(CI_SEED));
  expect(hashes(CI_SEED)).not.toEqual(hashes(CI_SEED + 1));
});

linuxTest("hostile parser corpus and seeded CI budget", async () => {
  const result = await runFuzz();
  const failure = result.receipts.find(receipt => receipt.code !== 0 || receipt.limit !== null || receipt.property !== null);
  expect(failure, JSON.stringify(failure)).toBeUndefined();
  expect(result.receipts.map(receipt => receipt.target)).toEqual(TARGETS);
  for (const receipt of result.receipts) {
    expect(receipt).toMatchObject({ code: 0, limit: null, property: null, completed: CORPUS_SIZE + 8 });
    expect(receipt.peakRssKiB).toBeLessThanOrEqual(512 * 1024);
  }
}, 480_000);

const PROBE = join(import.meta.dir, "supervisor-probe.ts");

linuxTest("supervisor kills and reaps a synchronous hang", async () => {
  const result = await supervise([process.execPath, PROBE, "hang"], { timeoutMs: 300, rssMiB: 512 });
  expect(result.limit).toBe("time");
  expect(result.code).not.toBe(0);
});

linuxTest("supervisor refuses an RSS budget breach", async () => {
  const result = await supervise([process.execPath, PROBE, "memory"], { timeoutMs: 5000, rssMiB: 128 });
  expect(result.limit).toBe("memory");
});

linuxTest("supervisor bounds output even when the child exits immediately", async () => {
  const result = await supervise([process.execPath, PROBE, "output"], { timeoutMs: 5000, rssMiB: 512 });
  expect(result.limit).toBe("output");
});

linuxTest("a successful exit without a completion receipt fails closed", async () => {
  const result = await supervise([process.execPath, PROBE, "early-exit"], { timeoutMs: 5000, rssMiB: 512 });
  expect(result.property).toBe("worker-incomplete");
});

linuxTest("worker RSS receipts exclude the larger parent address space", async () => {
  const held = Buffer.alloc(192 * 1024 * 1024, 1);
  const result = await supervise([process.execPath, PROBE, "receipt"], { timeoutMs: 5000, rssMiB: 128 });
  expect(result).toMatchObject({ code: 0, limit: null, property: null, completed: 0 });
  expect(result.peakRssKiB).toBeLessThanOrEqual(128 * 1024);
  // Keep the parent allocation resident until after the child has been reaped.
  expect(held[held.length - 1]).toBe(1);
});
