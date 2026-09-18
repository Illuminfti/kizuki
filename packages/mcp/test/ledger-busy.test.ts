import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServeContext } from "@kizuki/core";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

const HOLDER = join(import.meta.dir, "../../core/test/ledger-busy-child.ts");

interface Holder {
  release(): Promise<void>;
}

/** Another process holding the ledger write lock, as a serve rail batch does. */
async function holdWriteLock(
  vaultPath: string,
  holdMs: number,
): Promise<Holder> {
  const child = Bun.spawn(
    [
      process.execPath,
      HOLDER,
      join(vaultPath, ".kizuki", "kizuki.db"),
      String(holdMs),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  expect(buffered.split("\n")[0]).toBe("held");
  reader.releaseLock();
  return {
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
    },
  };
}

async function connect(ctx: ServeContext): Promise<Client> {
  return connectClient(ctx, open);
}

test("an agent read still answers while another writer holds the ledger", async () => {
  fixture = mcpFixture();
  const client = await connect(fixture.owner());
  const holder = await holdWriteLock(fixture.vaultPath, 1_200);
  try {
    // Serving reserves an audit row, which is a write on the same ledger.
    const result = await call(client, "search", { query: "kettle" });
    expect(result.isError).toBeUndefined();
    expect(envelopeOf(result)["tool"]).toBe("search");
  } finally {
    await holder.release();
  }
}, 60_000);

test("a writer that outlasts the wait is a typed busy refusal, not a lock error", async () => {
  fixture = mcpFixture();
  const client = await connect(fixture.owner());
  const holder = await holdWriteLock(fixture.vaultPath, 120_000);
  try {
    const result = await call(client, "search", { query: "kettle" });
    expect(result.isError).toBe(true);
    const refusal = JSON.parse(result.content[0]?.text ?? "{}") as {
      error?: string;
      message?: string;
      retry_after_seconds?: number | null;
    };
    expect(refusal.error).toBe("busy");
    expect(String(refusal.message)).not.toContain("database is locked");
    expect(refusal.retry_after_seconds).toBe(1);
  } finally {
    await holder.release();
  }
}, 120_000);
