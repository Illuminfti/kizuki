import { describe, expect, test } from "bun:test";
import {
  applyAllowlist,
  parseAllowlist,
  scanSourceText,
  scanTrackedSources,
} from "./verify-network";

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

  test("parseAllowlist accepts comments and rejects broken lines", () => {
    expect(parseAllowlist("# none yet\n\n")).toEqual([]);
    expect(
      parseAllowlist("packages/core/src/net.ts:user-configured model endpoint\n"),
    ).toEqual([
      {
        path: "packages/core/src/net.ts",
        reason: "user-configured model endpoint",
        line: 1,
      },
    ]);
    expect(() => parseAllowlist("no-colon\n")).toThrow("missing ':'");
    expect(() => parseAllowlist("packages/core/src/net.ts:\n")).toThrow("empty");
    expect(() =>
      parseAllowlist(
        "packages/core/src/net.ts:one\npackages/core/src/net.ts:two\n",
      ),
    ).toThrow("duplicates");
  });

  test("applyAllowlist separates findings and marks stale entries", () => {
    const finding = {
      file: "packages/core/src/net.ts",
      line: 1,
      column: 1,
      reason: "network API call: fetch",
    };
    const live = {
      path: "packages/core/src/net.ts",
      reason: "user-configured model endpoint",
      line: 1,
    };
    const staleUntracked = {
      path: "packages/missing/src/net.ts",
      reason: "gone",
      line: 2,
    };
    const staleEmpty = {
      path: "packages/core/src/clean.ts",
      reason: "unused",
      line: 3,
    };
    const scan = applyAllowlist(
      [finding],
      [live, staleUntracked, staleEmpty],
      ["packages/core/src/net.ts", "packages/core/src/clean.ts"],
    );
    expect(scan.findings).toEqual([]);
    expect(scan.allowlisted).toEqual([{ entry: live, findings: [finding] }]);
    expect(scan.stale).toEqual([staleUntracked, staleEmpty]);
  });

  test("the tracked tree has no unallowlisted network calls or stale entries", async () => {
    const scan = await scanTrackedSources();
    expect(scan.findings).toEqual([]);
    expect(scan.stale).toEqual([]);
  });
});
