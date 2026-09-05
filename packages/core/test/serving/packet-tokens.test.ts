import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";
import { serveContextPacket } from "../../src/serving/packet";
import { rebuildDerived } from "../../src/derived";
import { ServeError } from "../../src/serving/types";
import { page, serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

const encoding = new Tiktoken(ranks);
const count = (text: string) => encoding.encode(text, [], []).length;
let fixture: Fixture | undefined;
afterEach(() => fixture?.dispose());

function live() {
  fixture = serveFixture();
  return fixture;
}

test("the mandatory header refuses an insufficient budget with its numeric minimum", async () => {
  const f = live();
  try {
    await serveContextPacket(f.owner(), { budget_tokens: 50, include: [] });
    throw new Error("expected header refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ServeError);
    expect((error as ServeError).code).toBe("invalid_arguments");
    expect((error as Error).message).toMatch(/budget_tokens: mandatory header requires at least \d+ tokens/);
  }
});

test("the exact header boundary fits and an unchanged marker cannot overflow it", async () => {
  const f = live();
  const sample = (await serveContextPacket(f.owner(), { budget_tokens: 450, include: [] })).data!;
  const budget = count(sample.packet_md.replace("budget=450", "budget=55"));
  const first = (await serveContextPacket(f.owner(), { budget_tokens: budget, include: [] })).data!;
  expect(first.tokens_estimate).toBe(count(first.packet_md));
  expect(first.tokens_estimate).toBe(budget);
  await expect(serveContextPacket(f.owner(), { budget_tokens: budget - 1, include: [] }))
    .rejects.toThrow(`mandatory header requires at least ${budget} tokens`);
  const again = (await serveContextPacket(f.owner(), {
    budget_tokens: budget, include: [], capabilities: ["delta"], retain_prefix: true,
    prior_hash: first.packet_hash,
  })).data!;
  expect(count(again.packet_md)).toBeLessThanOrEqual(budget);
  expect(again.delivery).toBe("full");
  const delta = (await serveContextPacket(f.owner(), {
    budget_tokens: 100, include: [], capabilities: ["delta"], retain_prefix: true,
    prior_hash: first.packet_hash,
  })).data!;
  expect(delta.delivery).toBe("unchanged");
  expect(delta.tokens_estimate).toBe(count(delta.packet_md));
  expect(count(delta.packet_md)).toBeLessThanOrEqual(100);
});

for (const prose of [
  "知識と記憶は文脈によって変わります。中文检索保持来源。",
  "👩🏽‍💻🧑‍🚀🏳️‍🌈🪿✨",
  "const result = values.map((x) => ({...x, id: `item-${x.id}`}));",
  "مرحبا بالعالم नमस्ते दुनिया Привет мир",
  "<|endoftext|><|fim_prefix|><|fim_suffix|>",
]) {
  test(`full packets count source text exactly: ${prose.slice(0, 12)}`, async () => {
    const f = live();
    page(f.vaultPath, "facts/token-test.md", {
      id: "fact:token-test", title: "Tokenizer fixture", type: "fact",
      status: "active", sensitivity: "public", taint: "clean",
    }, prose.repeat(8));
    rebuildDerived(f.db, f.vaultPath);
    for (const budget of [80, 120, 200, 450, 2000]) {
      const data = (await serveContextPacket(f.owner(), {
        query: "Tokenizer", include: ["canon"], budget_tokens: budget,
      })).data!;
      expect(data.tokenizer).toBe("js-tiktoken@1.0.21/cl100k_base");
      expect(data.tokens_estimate).toBe(count(data.packet_md));
      expect(count(data.packet_md)).toBeLessThanOrEqual(budget);
      if (budget === 2000) expect(data.packet_md).toContain(prose.slice(0, 12));
    }
  });
}

test("a copied compiled tokenizer works with fetch denied and bundled ranks", () => {
  const build = mkdtempSync(join(tmpdir(), "kizuki-token-build-"));
  const run = mkdtempSync(join(tmpdir(), "kizuki-token-run-"));
  try {
    const source = join(build, "check.ts");
    const modulePath = new URL("../../src/serving/packet-tokenizer.ts", import.meta.url).pathname;
    const sample = "中文 👩🏽‍💻 <|endoftext|> const value = 42;";
    writeFileSync(source,
      `globalThis.fetch = async () => { throw new Error("network forbidden"); };\n` +
      `const { packetTokens } = await import(${JSON.stringify(modulePath)});\n` +
      `console.log(packetTokens(${JSON.stringify(sample)}));\n`,
    );
    const executable = join(build, "tokenizer");
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", executable]);
    expect(compiled.exitCode).toBe(0);
    const copied = join(run, "tokenizer");
    copyFileSync(executable, copied);
    const result = Bun.spawnSync([copied], { cwd: run });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(String(count(sample)));
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(build, { recursive: true, force: true });
    rmSync(run, { recursive: true, force: true });
  }
}, 30_000);
