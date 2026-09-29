import { expect, test } from "bun:test";
import { LedgerLeaseHeldError } from "@kizuki/core";
import { STARTUP_HELD_BACKOFF_MS, untilLedgerFree } from "../src/startup-wait";

const held = () => new LedgerLeaseHeldError("lease_held: another kizuki process holds the ledger writer lease");

test("a start refused because the ledger is held waits, says so, and starts again", async () => {
  const lines: string[] = [];
  const naps: number[] = [];
  let attempts = 0;
  const result = await untilLedgerFree(
    async () => {
      attempts += 1;
      if (attempts <= 4) throw held();
      return "started";
    },
    { log: (line) => lines.push(line), sleep: async (ms) => void naps.push(ms) },
  );
  expect(result).toBe("started");
  expect(attempts).toBe(5);
  expect(naps).toEqual([2_000, 4_000, 8_000, 16_000]);
  expect(lines.map((line) => JSON.parse(line))).toEqual(
    naps.map((retry_in_ms) => ({
      event: "start_held",
      reason: "lease_held",
      retry_in_ms,
      next: "the daemon starts when the writer releases the ledger; nothing is lost",
    })),
  );
});

test("the wait between starts is bounded", async () => {
  const naps: number[] = [];
  let attempts = 0;
  await untilLedgerFree(
    async () => {
      if ((attempts += 1) <= 8) throw held();
    },
    { log: () => undefined, sleep: async (ms) => void naps.push(ms) },
  );
  expect(Math.max(...naps)).toBe(STARTUP_HELD_BACKOFF_MS.cap);
});

test("any other refusal still ends the start at once", async () => {
  let attempts = 0;
  const failure = new Error("vault ledger missing");
  await expect(
    untilLedgerFree(
      async () => {
        attempts += 1;
        throw failure;
      },
      { log: () => undefined, sleep: async () => undefined },
    ),
  ).rejects.toBe(failure);
  expect(attempts).toBe(1);
});
