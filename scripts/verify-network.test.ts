import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("parseAllowlist accepts comments and rejects broken lines", () => {
    expect(parseAllowlist("# none yet\n\n")).toEqual([]);
    expect(
      parseAllowlist("packages/core/src/net.ts:(toplevel).fetch#1:user-configured model endpoint\n"),
    ).toEqual([
      {
        path: "packages/core/src/net.ts",
        site: "(toplevel).fetch#1",
        reason: "user-configured model endpoint",
        line: 1,
      },
    ]);
    expect(() => parseAllowlist("no-colon\n")).toThrow("missing ':'");
    expect(() => parseAllowlist("packages/core/src/net.ts:fetch#1:\n")).toThrow("empty");
    expect(() => parseAllowlist("packages/core/src/net.ts:reason-only\n")).toThrow(
      "call-site fingerprint",
    );
    expect(() =>
      parseAllowlist(
        "packages/core/src/net.ts:(toplevel).fetch#1:one\npackages/core/src/net.ts:(toplevel).fetch#1:two\n",
      ),
    ).toThrow("duplicates");
  });

  test("applyAllowlist consumes one matching site and marks stale entries", () => {
    const finding = {
      file: "packages/core/src/net.ts",
      line: 1,
      column: 1,
      reason: "network API call: fetch",
      site: "(toplevel).fetch#1",
    };
    const live = {
      path: "packages/core/src/net.ts",
      site: "(toplevel).fetch#1",
      reason: "user-configured model endpoint",
      line: 1,
    };
    const staleUntracked = {
      path: "packages/missing/src/net.ts",
      site: "(toplevel).fetch#1",
      reason: "gone",
      line: 2,
    };
    const staleEmpty = {
      path: "packages/core/src/clean.ts",
      site: "(toplevel).fetch#1",
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

  test("applyAllowlist does not let one site cover a second call in the same file", () => {
    const first = {
      file: "packages/core/src/net.ts",
      line: 1,
      column: 1,
      reason: "network API call: fetch",
      site: "(toplevel).fetch#1",
    };
    const second = {
      file: "packages/core/src/net.ts",
      line: 2,
      column: 1,
      reason: "network API call: fetch",
      site: "(toplevel).fetch#2",
    };
    const live = {
      path: "packages/core/src/net.ts",
      site: "(toplevel).fetch#1",
      reason: "user-configured model endpoint",
      line: 1,
    };
    const scan = applyAllowlist([first, second], [live], ["packages/core/src/net.ts"]);
    expect(scan.findings).toEqual([second]);
    expect(scan.allowlisted).toEqual([{ entry: live, findings: [first] }]);
    expect(scan.stale).toEqual([]);
  });

  test("scanSourceText fingerprints enclosing symbols and duplicate calls", () => {
    const findings = scanSourceText(
      "packages/example.ts",
      `
        fetch("https://example.invalid/one");
        fetch("https://example.invalid/two");
        function send() { fetch("https://example.invalid/three"); }
      `,
    );
    expect(findings.map((item) => item.site)).toEqual([
      "(toplevel).fetch#1",
      "(toplevel).fetch#2",
      "send.fetch#1",
    ]);
  });

  test("scanSourceText rejects aliases and destructuring of network APIs", () => {
    expect(
      scanSourceText(
        "packages/example.ts",
        'const f = fetch; f("https://example.invalid")',
      ).map((item) => item.reason),
    ).toEqual(["network API call: fetch"]);
    expect(
      scanSourceText(
        "packages/example.ts",
        'const {fetch: g} = globalThis; g("https://example.invalid")',
      ).map((item) => item.reason),
    ).toEqual(["network API call: fetch"]);
    expect(
      scanSourceText(
        "packages/example.ts",
        'const f = fetch; const h = f; h("https://example.invalid")',
      ).map((item) => item.reason),
    ).toEqual(["network API call: fetch"]);
  });

  test("scanSourceText does not confuse a shadowed local function with fetch", () => {
    expect(
      scanSourceText(
        "packages/example.ts",
        'function fetch(url) { return url; } fetch("https://example.invalid")',
      ),
    ).toEqual([]);
  });

  test("applyAllowlist accepts reviewed scripts outside packages/", () => {
    const finding = {
      file: "scripts/tool.mjs",
      line: 1,
      column: 1,
      reason: "network API call: fetch",
      site: "(toplevel).fetch#1",
    };
    const live = {
      path: "scripts/tool.mjs",
      site: "(toplevel).fetch#1",
      reason: "loopback fixture",
      line: 1,
    };
    const scan = applyAllowlist([finding], [live], ["scripts/tool.mjs"]);
    expect(scan.findings).toEqual([]);
    expect(scan.allowlisted).toEqual([{ entry: live, findings: [finding] }]);
    expect(scan.stale).toEqual([]);
  });

  test("scanSourceText covers .cts modules", () => {
    expect(scanSourceText("scripts/nested/tool.cts", 'fetch("https://example.invalid")')).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("fetch") }),
    ]);
  });

  test("the tracked tree has no unallowlisted network calls or stale entries", async () => {
    const scan = await scanTrackedSources();
    expect(scan.findings).toEqual([]);
    expect(scan.stale).toEqual([]);
  });

  test("tracked JS/TS outside packages is scanned; untracked noise is ignored", async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-network-scan-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "root.ts"), 'fetch("https://example.invalid")\n');
      writeFileSync(join(root, "scripts", "tool.mjs"), 'fetch("https://example.invalid")\n');
      writeFileSync(join(root, "nested", "tool.cts"), 'fetch("https://example.invalid")\n');
      writeFileSync(join(root, "untracked.ts"), 'fetch("https://example.invalid")\n');
      writeFileSync(join(root, "scripts", "network-allowlist.txt"), "# none\n");
      const git = (args: string[]) => {
        const result = Bun.spawnSync({
          cmd: ["git", ...args],
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.toString());
        }
      };
      git(["init"]);
      git(["config", "user.email", "scan@example.invalid"]);
      git(["config", "user.name", "scan"]);
      git(["add", "root.ts", "scripts/tool.mjs", "nested/tool.cts", "scripts/network-allowlist.txt"]);
      git(["commit", "-m", "fixture"]);
      const scan = await scanTrackedSources({
        cwd: root,
        allowlistPath: "scripts/network-allowlist.txt",
      });
      expect(scan.findings.map((item) => item.file).sort()).toEqual([
        "nested/tool.cts",
        "root.ts",
        "scripts/tool.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git enumeration failure is a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-network-nongit-"));
    try {
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts", "network-allowlist.txt"), "# none\n");
      await expect(
        scanTrackedSources({ cwd: root, allowlistPath: "scripts/network-allowlist.txt" }),
      ).rejects.toThrow("tracked-source producer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
