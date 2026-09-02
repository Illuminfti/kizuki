import { describe, expect, test } from "bun:test";
import { parseAllowlist, partitionFindings, scanSourceText } from "./verify-network";
import type { NetworkFinding } from "./verify-network";

describe("network source verification", () => {
  test.each([
    ['fetch ("https://example.invalid")', "fetch"],
    ['globalThis["fetch"]("https://example.invalid")', "globalThis.fetch"],
    ['import https from "https"', "https"],
    ['const tls = require("node:tls")', "node:tls"],
    ['await import("undici")', "undici"],
    ['Bun["serve"]({ fetch() {} })', "Bun.serve"],
    ['new window["WebSocket"]("wss://example.invalid")', "window.WebSocket"],
    ['process.getBuiltinModule("node:http")', "node:http"],
  ])("rejects %s", (source, expected) => {
    expect(scanSourceText("packages/example.ts", source)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining(expected) }),
    ]);
  });

  test("ignores comments, strings, and unrelated property names", () => {
    const source = `
      // fetch("https://example.invalid")
      const note = "node:https and WebSocket";
      const local = fixture.fetch;
    `;
    expect(scanSourceText("packages/example.ts", source)).toEqual([]);
  });
});

describe("network allowlist", () => {
  const finding = (file: string): NetworkFinding => ({
    file,
    line: 1,
    column: 1,
    reason: "network API call: fetch",
  });

  test("parseAllowlist keeps order, skips comments and blank lines, and splits on the first colon", () => {
    const entries = parseAllowlist(
      "# header\n\npackages/a/src/x.ts: reason: with colon \n\n packages/b/test/y.ts:another\n",
    );
    expect(entries).toEqual([
      { path: "packages/a/src/x.ts", reason: "reason: with colon" },
      { path: "packages/b/test/y.ts", reason: "another" },
    ]);
  });

  test("an empty or comment-only allowlist has no entries", () => {
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("# nothing may leave\n")).toEqual([]);
  });

  test.each([
    ["packages/a.ts", /line 1: expected <path>:<reason>/],
    ["packages/a.ts:   ", /line 1: empty reason/],
    [":why", /line 1: empty path/],
    ["packages/a.ts:one\npackages/a.ts:two", /line 2: duplicate path packages\/a.ts/],
  ])("parseAllowlist refuses %j", (text, message) => {
    expect(() => parseAllowlist(text)).toThrow(message);
  });

  test("partitionFindings separates allowed from violations and names stale entries", () => {
    const partition = partitionFindings(
      [finding("packages/a.ts"), finding("packages/b.ts"), finding("packages/a.ts")],
      [
        { path: "packages/a.ts", reason: "ok" },
        { path: "packages/quiet.ts", reason: "no findings any more" },
        { path: "packages/gone.ts", reason: "not tracked" },
      ],
      new Set(["packages/a.ts", "packages/b.ts", "packages/quiet.ts"]),
    );
    expect(partition.allowed).toEqual([finding("packages/a.ts"), finding("packages/a.ts")]);
    expect(partition.violations).toEqual([finding("packages/b.ts")]);
    expect(partition.stale).toEqual(["packages/quiet.ts", "packages/gone.ts"]);
  });

  test("an empty allowlist makes every finding a violation", () => {
    const partition = partitionFindings(
      [finding("packages/a.ts")],
      [],
      new Set(["packages/a.ts"]),
    );
    expect(partition).toEqual({
      violations: [finding("packages/a.ts")],
      allowed: [],
      stale: [],
    });
  });
});
