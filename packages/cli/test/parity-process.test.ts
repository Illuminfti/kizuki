import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";
import { askKizuki, contextAnswer } from "../src/parity/kizuki";
import { boundedCommand } from "../src/parity/process";
import { runParity } from "../src/parity/run";
import { cliArgs } from "../src/runtime";

const h = createHelpers();
afterAll(h.cleanup);
const ESTATE = resolve(import.meta.dir, "fixtures/parity-estate.ts");

test("the real Kizuki child is killed on deadline and the next query still produces a receipt row", async () => {
  const f = h.tempVault();
  const receipt = await runParity({ queries: ["first", "second"], estate: [process.execPath, ESTATE, "keys", "-", "-"], k: 1, timeoutMs: 5000, minOverlap: 0.5 },
    query => askKizuki(f.vault, query, { timeoutMs: query === "first" ? 1 : 5000, env: f.env }));
  expect(receipt.queries.map(row => row.kizuki.error_class)).toEqual(["timeout", null]);
  expect(receipt.queries).toHaveLength(2);
  expect(receipt.summary.exit_code).toBe(1);
  expect(receipt.queries[0]!.kizuki.latency_ms).toBeLessThan(5000);
}, 30000);

async function childPid(file: string): Promise<number> {
  for (let wait = 0; wait < 500; wait++) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    }
    await Bun.sleep(10);
  }
  throw new Error("owned grandchild did not become ready");
}
async function expectDead(pid: number) {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let wait = 0; wait < 100 && alive(); wait++) await Bun.sleep(20);
  expect(alive()).toBe(false);
}

test("cancellation reaps the owned wrapper and kills its grandchild", async () => {
  const file = join(h.tempDir("parity-cancel-"), "pid"), abort = new AbortController();
  const answer = boundedCommand([process.execPath, ESTATE, "orphan", file, "-"], { timeoutMs: 10000, signal: abort.signal });
  const pid = await childPid(file);
  abort.abort();
  expect((await answer).error).toBe("cancelled");
  await expectDead(pid);
}, 20000);

test("interrupting the actual parity CLI leaves no owned estate grandchild", async () => {
  const f = h.tempVault(), file = join(f.root, "pid"), queries = join(f.root, "queries.txt");
  writeFileSync(queries, "synthetic query\n");
  const child = Bun.spawn(cliArgs(["parity", "run", "--vault", f.vault, "--queries", queries, "--timeout-ms", "10000", "--estate-cmd", "--", process.execPath, ESTATE, "orphan", file, "-"]),
    { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    const pid = await childPid(file);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    const [stdout, stderr] = await output;
    expect(stdout).toBe(""); expect(stderr).toContain("parity interrupted");
    await expectDead(pid);
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; await output; }
}, 30000);

test("malformed Kizuki output is classified without persisting private child text", () => {
  for (const text of ["Private Sentinel", "{}", JSON.stringify({ schema: "kizuki.cli.context/v1", data: { denied: [], data: {}, canon: [], quoted: [] } })])
    expect(contextAnswer(text)).toEqual({ ok: false, errorClass: "kizuki_error" });
});

test("unknown degradation text never enters a hashes-only receipt", () => {
  expect(contextAnswer(JSON.stringify({ schema: "kizuki.cli.context/v1", data: {
    denied: [], canon: [], quoted: [], data: { retrieval_degraded: ["private_sentinel", "query-relaxed"] },
  } }))).toEqual({ ok: true, chunks: [], degraded: ["retrieval-degraded", "query-relaxed"] });
});

test("an option-shaped query stays data in the actual Kizuki child", async () => {
  const f = h.tempVault();
  expect((await askKizuki(f.vault, "--vault=private-sentinel", { timeoutMs: 10000, env: f.env })).ok).toBe(true);
}, 20000);
