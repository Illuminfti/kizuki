import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenResolver, validTokenRef } from "../src/secrets";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(() => h.cleanup());

describe("connection token references", () => {
  test("resolves only its enrolled environment reference and redacts failures", async () => {
    const resolver = tokenResolver("env:APP_TOKEN", { APP_TOKEN: "private-token", OTHER: "other" });
    await expect(resolver("env:APP_TOKEN")).resolves.toBe("private-token");
    await expect(resolver("env:OTHER")).rejects.toThrow("not granted");
    await expect(tokenResolver("env:MISSING", {})("env:MISSING")).rejects.toThrow("missing or invalid");
    expect(validTokenRef("env:bad-name")).toBe(false);
  });

  test("refuses unsafe token files without echoing their bytes", async () => {
    const dir = h.tempDir("kizuki-secret-");
    const safe = join(dir, "safe");
    const group = join(dir, "group");
    const huge = join(dir, "huge");
    const link = join(dir, "link");
    const fifo = join(dir, "fifo");
    writeFileSync(safe, "private-token\n", { mode: 0o600 });
    writeFileSync(group, "group-token\n", { mode: 0o600 }); chmodSync(group, 0o640);
    writeFileSync(huge, "x".repeat(16_385), { mode: 0o600 });
    symlinkSync(safe, link);
    expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
    await expect(tokenResolver(`file:${safe}`, {})(`file:${safe}`)).resolves.toBe("private-token");
    for (const path of [group, huge, link, fifo]) {
      await expect(tokenResolver(`file:${path}`, {})(`file:${path}`)).rejects.toThrow("owner-only regular file");
    }
  });
});
