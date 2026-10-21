import { expect, test } from "bun:test";

for (const [path, name] of [
  ["../../src/claims/store.ts", "reinstateClaim"],
  ["../../src/world/pipeline/collect.ts", "collectCard"],
  ["../../src/world/public.ts", "serveWorldView"],
] as const) test(`cold import of ${path} initializes its World dependencies`, () => {
  const source = `const entry = await import(${JSON.stringify(new URL(path, import.meta.url).href)}); if (typeof entry[${JSON.stringify(name)}] !== 'function') throw Error('missing entry point');`;
  const child = Bun.spawnSync({ cmd: [process.execPath, "--eval", source], stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toBe("");
}, 15_000);
