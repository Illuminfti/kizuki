import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSource, sourceRow } from "./corpus";
import { options, outputDirectory } from "./run";
import { ROOT, childEnvironment, command } from "./process";
import { assertCliRead, assertRead } from "./reads";
import { distribution, percentile } from "./report";

test("the seed reproduces the complete logical source; a different seed changes its hash", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-source-test-"));
  try {
    const first = createSource(join(root, "first.sqlite"), 1_000, 1);
    expect(createSource(join(root, "second.sqlite"), 1_000, 1)).toBe(first);
    expect(createSource(join(root, "third.sqlite"), 1_000, 2)).not.toBe(first);
    expect(sourceRow(0, 1, 4).text).toBe(sourceRow(4, 1, 4).text);
    expect(sourceRow(0, 1, 4).record_id).not.toBe(sourceRow(4, 1, 4).record_id);
    expect(sourceRow(1, 1, 4).text).not.toBe(sourceRow(0, 1, 4).text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe and ambiguous arguments fail before creating a vault", () => {
  for (const argv of [["--size", "XXL"], ["--size", "M", "--smoke"], ["--seed", "-1"], ["--seed", "4294967296"], ["--seed", "1", "--seed", "2"], ["--out"], ["--unknown", "x"]]) expect(() => options(argv)).toThrow();
  expect(options(["--size", "XL", "--seed", "4294967295"])).toMatchObject({ size: "XL", seed: 4294967295, smoke: false });
});

test("output refuses repository paths including symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-path-test-"));
  try {
    expect(() => outputDirectory(join(ROOT, "bench-results"))).toThrow("outside the repository");
    symlinkSync(ROOT, join(root, "repository"), "dir");
    expect(() => outputDirectory(join(root, "repository", "nested", "result"))).toThrow("outside the repository");
    mkdirSync(join(root, "output"));
    expect(outputDirectory(join(root, "output"))).toBe(join(root, "output"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nearest-rank tails retain outliers and samples in their original order", () => {
  expect(percentile([], .5)).toBeNull();
  const samples = [100, 1, 2, 3, 4];
  expect(distribution("ms", samples)).toMatchObject({ samples: [100, 1, 2, 3, 4], p50: 3, p95: 100, p99: 100 });
});

test("a refused or empty read is never a successful fast benchmark", () => {
  expect(() => assertRead("search", { isError: true })).toThrow();
  expect(() => assertRead("get_page", { structuredContent: { canon: [] } })).toThrow();
  expect(() => assertRead("world_discovery", { structuredContent: { data: { matches: [] } } })).toThrow();
  expect(() => assertRead("graph_neighbors", { structuredContent: { data: { edges: [] } } })).toThrow();
  expect(() => assertCliRead("search", { schema: "kizuki.cli.query/v1", data: { hits: [] } })).toThrow();
  expect(() => assertCliRead("context_session", { schema: "kizuki.cli.context/v1", data: {} })).toThrow();
});

test("children receive only explicit runtime variables and no model credentials", () => {
  expect(Object.keys(childEnvironment()).sort()).toEqual(["KIZUKI_NO_SERVICE", "LANG", "PATH", "TMPDIR", "TZ", "XDG_CONFIG_HOME"]);
});

test("child peak RSS is normalized to bytes against a resident allocation", async () => {
  const retained = Buffer.alloc(256 * 1024 * 1024, 1);
  const result = await command(["-e", "const buffer=Buffer.alloc(64*1024*1024,1); console.log(process.memoryUsage().rss); console.log(buffer[0]);"]);
  const resident = Number(result.stdout.split("\n")[0]);
  expect(result.rss_bytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  expect(result.rss_bytes).toBeGreaterThan(resident * .8);
  expect(result.rss_bytes).toBeLessThan(resident * 2);
  expect(retained[0]).toBe(1);
});
