import { describe, expect, test } from "bun:test";
import {
  applyAllowlist,
  parseAllowlist,
  scanSourceText,
  scanTrackedSources,
} from "./verify-network";
import type { NetworkFinding } from "./verify-network";

describe("network source verification", () => {
  test.each([
    ['fetch ("https://example.invalid")', "fetch"],
    ['globalThis["fetch"]("https://example.invalid")', "globalThis.fetch"],
    ['import https from "https"', "https"],
    ['const tls = require("node:tls")', "node:tls"],
    ['await import("undici")', "undici"],
    ['Bun["serve"]({ fetch() {} })', "Bun.serve"],
    ['Bun.listen({ hostname: "127.0.0.1", port: 0 })', "Bun.listen"],
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
  test("reads path and reason, skipping comments and blank lines", () => {
    expect(
      parseAllowlist(
        [
          "# why this file may open a socket",
          "",
          "packages/core/src/auth/loopback.ts:loopback listener: Bun.serve and fetch",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "packages/core/src/auth/loopback.ts",
        reason: "loopback listener: Bun.serve and fetch",
        line: 3,
      },
    ]);
  });

  test("rejects a line that carries no reason", () => {
    expect(() => parseAllowlist("\npackages/core/src/auth/loopback.ts\n")).toThrow(
      "line 2",
    );
  });

  test("rejects an empty reason", () => {
    expect(() => parseAllowlist("packages/core/src/a.ts:")).toThrow("empty reason");
  });

  test("rejects the same path twice", () => {
    expect(() =>
      parseAllowlist(
        ["packages/core/src/a.ts:one", "packages/core/src/a.ts:two"].join("\n"),
      ),
    ).toThrow("duplicate path");
  });
});

describe("allowlist application", () => {
  const finding = (file: string): NetworkFinding => ({
    file,
    line: 1,
    column: 1,
    reason: "network API call: fetch",
  });

  test("separates allowlisted findings from the ones that fail the gate", () => {
    const scan = applyAllowlist(
      [finding("packages/core/src/auth/loopback.ts"), finding("packages/core/src/other.ts")],
      parseAllowlist("packages/core/src/auth/loopback.ts:sign-in transport"),
      ["packages/core/src/auth/loopback.ts", "packages/core/src/other.ts"],
    );
    expect(scan.findings).toEqual([finding("packages/core/src/other.ts")]);
    expect(scan.allowlisted).toHaveLength(1);
    expect(scan.allowlisted[0]?.findings).toHaveLength(1);
    expect(scan.stale).toEqual([]);
  });

  test("marks an entry whose file no longer opens a socket stale", () => {
    const scan = applyAllowlist(
      [],
      parseAllowlist("packages/core/src/auth/loopback.ts:sign-in transport"),
      ["packages/core/src/auth/loopback.ts"],
    );
    expect(scan.stale).toHaveLength(1);
    expect(scan.allowlisted).toEqual([]);
  });

  test("marks an untracked path stale", () => {
    const scan = applyAllowlist(
      [finding("packages/core/src/gone.ts")],
      parseAllowlist("packages/core/src/gone.ts:sign-in transport"),
      [],
    );
    expect(scan.stale).toHaveLength(1);
    expect(scan.findings).toHaveLength(1);
  });

  test("only a declared test may be allowlisted under test/", () => {
    const path = "packages/core/test/auth/loopback.test.ts";
    const withoutMarker = applyAllowlist(
      [finding(path)],
      parseAllowlist(`${path}:exercises the transport`),
      [path],
    );
    expect(withoutMarker.stale).toHaveLength(1);

    const withMarker = applyAllowlist(
      [finding(path)],
      parseAllowlist(`${path}:test: exercises the transport over a real socket`),
      [path],
    );
    expect(withMarker.stale).toEqual([]);
    expect(withMarker.allowlisted).toHaveLength(1);
  });

  test("refuses a path outside packages/<pkg>/src", () => {
    const scan = applyAllowlist(
      [finding("scripts/probe.ts")],
      parseAllowlist("scripts/probe.ts:handy"),
      ["scripts/probe.ts"],
    );
    expect(scan.stale).toHaveLength(1);
  });
});

describe("this tree", () => {
  test("has no undeclared network surface and no stale declaration", async () => {
    const scan = await scanTrackedSources();
    expect(scan.findings).toEqual([]);
    expect(scan.stale).toEqual([]);
    expect(scan.allowlisted).toHaveLength(2);
  });
});
