import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { count, readSince } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

async function readReady(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("acceptance child ended before ready");
    buffered += new TextDecoder().decode(chunk.value);
    const newline = buffered.indexOf("\n");
    if (newline < 0) continue;
    expect(buffered.slice(0, newline + 1)).toBe("ready\n");
    return buffered.slice(newline + 1);
  }
}

test("acceptance barrier reads fragmented lines and retains trailing output", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("rea"));
      controller.enqueue(new TextEncoder().encode("dy\nstored\n"));
      controller.close();
    },
  });
  expect(await readReady(stream.getReader())).toBe("stored\n");
});

test("independent writers accept one source version once and return duplicate to every contender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-concurrent-"));
  const path = join(directory, "ledger.sqlite");
  openLedger(path).close();
  const children = Array.from({ length: 8 }, () => Bun.spawn([
    process.execPath, join(import.meta.dir, "ledger-accept-child.ts"), path,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  const readers = children.map(child => child.stdout.getReader());
  try {
    // All handles are open before any accept call starts. Each contender then
    // takes the real SQLite writer lock around duplicate lookup and insertion.
    const trailing = await Promise.all(readers.map(readReady));
    for (const child of children) {
      child.stdin.write("accept\n");
      child.stdin.end();
    }
    const results = await Promise.all(children.map(async (child, index) => {
      const reader = readers[index]!;
      const decoder = new TextDecoder();
      let output = trailing[index]!;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      output += decoder.decode();
      reader.releaseLock();
      return {
        exit: await child.exited,
        output: output.trim(),
        error: await new Response(child.stderr).text(),
      };
    }));
    expect(results.map(result => result.exit)).toEqual(Array(8).fill(0));
    expect(results.map(result => result.error)).toEqual(Array(8).fill(""));
    expect(results.map(result => result.output).sort())
      .toEqual([...Array<string>(7).fill("duplicate"), "stored"]);
    const db = openLedger(path);
    try {
      expect(count(db)).toBe(1);
      expect(readSince(db, null, 10).events[0]).toMatchObject(validEvent());
    } finally {
      db.close();
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
