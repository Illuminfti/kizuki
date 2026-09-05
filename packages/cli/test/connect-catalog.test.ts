import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(() => h.cleanup());

describe("connect catalog", () => {
  test("catalog needs neither a vault nor a secret and labels unavailable sources honestly", () => {
    const result = h.runCli(h.isolatedEnv(), "connect", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const sources = JSON.parse(result.stdout).data.sources as Array<{ id: string; available: boolean }>;
    expect(sources.some((source) => source.id === "kizuki.markdown-folder" && source.available)).toBe(true);
    expect(sources.some((source) => source.id === "kizuki.telegram" && !source.available)).toBe(true);
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
  });
});
