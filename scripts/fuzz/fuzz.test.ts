import { join } from "node:path";
import { expect, test } from "bun:test";
import { cases, CORPUS_SIZE } from "./cases";
import { CI_SEED, runFuzz, TARGETS } from "./run";
import { supervise } from "./supervisor";
import { parseCase } from "./parsers";

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

test("hostile parser corpus and seeded CI budget", async () => {
  const result = await runFuzz();
  const failure = result.receipts.find(receipt => receipt.code !== 0 || receipt.limit !== null || receipt.property !== null);
  expect(failure, JSON.stringify(failure)).toBeUndefined();
  expect(result.receipts.map(receipt => receipt.target)).toEqual(TARGETS);
  for (const receipt of result.receipts) {
    expect(receipt).toMatchObject({ code: 0, limit: null, property: null, completed: CORPUS_SIZE + 8 });
    expect(receipt.peakRssKiB).toBeLessThanOrEqual(512 * 1024);
  }
}, 120_000);

const PROBE = join(import.meta.dir, "supervisor-probe.ts");

test("supervisor kills and reaps a synchronous hang", async () => {
  const result = await supervise([process.execPath, PROBE, "hang"], { timeoutMs: 300, rssMiB: 512 });
  expect(result.limit).toBe("time");
  expect(result.code).not.toBe(0);
});

test("supervisor refuses an RSS budget breach", async () => {
  const result = await supervise([process.execPath, PROBE, "memory"], { timeoutMs: 5000, rssMiB: 128 });
  expect(result.limit).toBe("memory");
});

test("supervisor bounds output even when the child exits immediately", async () => {
  const result = await supervise([process.execPath, PROBE, "output"], { timeoutMs: 5000, rssMiB: 512 });
  expect(result.limit).toBe("output");
});
