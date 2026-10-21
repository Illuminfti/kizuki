import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSERS } from "./parsers";
import { FILE_TARGETS } from "./files";
import { SURFACES } from "./surfaces";
import { supervise } from "./supervisor";
import type { WorkerReceipt } from "./supervisor";
import { CORPUS_SIZE } from "./cases";

export const TARGETS = [...PARSERS, ...FILE_TARGETS, ...SURFACES];
export const CI_SEED = 0x51f00d;
/** Per-worker CI deadline: a hang bound, longer for the serving surfaces, which dispatch real tools against a real vault for every case. */
const ciTimeoutMs = (target: string) => (SURFACES as readonly string[]).includes(target) ? 90_000 : 20_000;
export interface RunOptions { seed?: number; cases?: number; target?: string; long?: boolean }

export async function runFuzz(options: RunOptions = {}): Promise<{ seed: number; receipts: (WorkerReceipt & { target: string })[] }> {
  const seed = options.seed ?? CI_SEED;
  const count = options.cases ?? (options.long ? 2000 : 8);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(count) || count < 0 || count > 100_000) throw new Error("invalid fuzz budget");
  if (options.target !== undefined && !TARGETS.includes(options.target as typeof TARGETS[number])) throw new Error("unknown fuzz target");
  const root = mkdtempSync(join(tmpdir(), "kizuki-fuzz-"));
  const receipts: (WorkerReceipt & { target: string })[] = [];
  try {
    for (const target of TARGETS.filter(target => options.target === undefined || target === options.target)) {
      const scratch = join(root, target); mkdirSync(scratch, { mode: 0o700 });
      const receipt = await supervise([process.execPath, join(import.meta.dir, "worker.ts"), target, String(seed), String(count), scratch],
        { timeoutMs: options.long ? 300_000 : ciTimeoutMs(target), rssMiB: 512 });
      if (receipt.code === 0 && receipt.property === null && receipt.completed !== CORPUS_SIZE + count) receipt.property = "worker-incomplete";
      receipts.push({ target, ...receipt });
      if (receipt.code !== 0 || receipt.limit !== null || receipt.property !== null) break;
    }
    return { seed, receipts };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options: RunOptions = {};
    for (let at = 0; at < args.length; at += 1) {
      const arg = args[at];
      if (arg === "--long") options.long = true;
      else if (arg === "--seed" || arg === "--cases" || arg === "--target") {
        const value = args[++at]; if (value === undefined) throw new Error("missing fuzz option value");
        if (arg === "--target") options.target = value;
        else if (arg === "--seed") options.seed = Number(value);
        else options.cases = Number(value);
      } else throw new Error("unknown fuzz option");
    }
    const result = await runFuzz(options);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.receipts.some(receipt => receipt.code !== 0 || receipt.limit !== null || receipt.property !== null)) process.exitCode = 1;
  } catch { process.stderr.write("fuzz configuration or supervision failed\n"); process.exitCode = 1; }
}
