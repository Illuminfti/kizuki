import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "@kizuki/connectors";
import { NOT_ENROLLABLE } from "../src/connect-catalog";
import { listEnrollableConnectorIds, resolveConnectorId } from "../src/connections";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(() => h.cleanup());

const CONNECT_DOC = readFileSync(
  join(import.meta.dir, "..", "..", "..", "docs", "connect.md"),
  "utf8",
).replace(/\s+/g, " ");

const registeredIds = (): string[] => Object.keys(REGISTRY).sort();

describe("connect catalog", () => {
  test("catalog needs neither a vault nor a secret and labels unavailable sources honestly", () => {
    const result = h.runCli(h.isolatedEnv(), "connect", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const sources = JSON.parse(result.stdout).data.sources as Array<{ id: string; available: boolean }>;
    expect(sources.some((source) => source.id === "kizuki.markdown-folder" && source.available)).toBe(true);
    expect(sources.some((source) => source.id === "kizuki.telegram" && !source.available)).toBe(true);
    expect(result.stdout).toContain("CLI wired; project app credentials missing");
  });

  test("status starts empty and names an enrolled local source without reading secrets", () => {
    const { env, notes } = h.tempVault();
    expect(h.runCli(env, "connect", "status").stdout).toContain("No sources connected yet.");
    const connected = h.runCli(env, "connect", "markdown-folder", "--source", notes);
    expect(connected.exitCode).toBe(0);
    const sourceKey = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)?.[1];
    expect(sourceKey).toBeDefined();
    const status = h.runCli(env, "connect", "status");
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("kizuki.markdown-folder");
    expect(status.stdout).toContain("Source");
    expect(status.stdout).toContain(sourceKey!);
    expect(status.stdout).toContain("not synced yet");
    // Three CLI subprocesses; the repository's other multi-spawn CLI tests
    // budget 8-30s rather than the 5s default.
  }, 30000);
});

describe("connector honesty", () => {
  test("the registry and the CLI's own dispatch agree on what can be enrolled", () => {
    const registered = registeredIds();
    expect(listEnrollableConnectorIds()).toEqual(registered);
    for (const id of registered) expect(resolveConnectorId(id)).toBe(id);
  });

  test("an advisory not-enrollable entry never becomes a connector the CLI resolves", () => {
    expect(NOT_ENROLLABLE.length).toBeGreaterThan(0);
    for (const entry of NOT_ENROLLABLE) {
      expect(registeredIds()).not.toContain(entry.id);
      expect(() => resolveConnectorId(entry.id)).toThrow(/unknown connector/);
    }
  });

  test("--json keeps the enrollable sources and names WHOOP under a separate key", () => {
    const result = h.runCli(h.isolatedEnv(), "connect", "--json");
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data as {
      sources: Array<{ id: string }>;
      not_enrollable: Array<{ id: string; name: string; reason: string }>;
    };
    expect(data.sources.map((source) => source.id).sort()).toEqual(registeredIds());
    expect(data.not_enrollable).toEqual([
      {
        id: "kizuki.whoop",
        name: "WHOOP",
        reason: NOT_ENROLLABLE[0]!.reason,
      },
    ]);
  });

  test("the printed catalog carries a separate not-enrollable section", () => {
    const result = h.runCli(h.isolatedEnv(), "connect");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not enrollable from this CLI");
    expect(result.stdout).toContain("WHOOP (kizuki.whoop)");
    expect(result.stdout).toContain(NOT_ENROLLABLE[0]!.reason);
  });

  test("connect whoop is refused as an unknown connector and enrolls nothing", () => {
    const { env, notes } = h.tempVault();
    const refused = h.runCli(env, "connect", "whoop", "--source", notes);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("unknown connector: whoop");
    expect(refused.stdout).not.toContain("connected");
    expect(h.runCli(env, "connect", "status").stdout).toContain("No sources connected yet.");
  }, 30000);

  test("docs/connect.md states the reason the catalog prints", () => {
    expect(CONNECT_DOC).toContain("Not enrollable from this CLI");
    for (const entry of NOT_ENROLLABLE) expect(CONNECT_DOC).toContain(entry.reason);
  });
});
