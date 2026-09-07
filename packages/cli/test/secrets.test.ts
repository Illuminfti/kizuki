import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenResolver, validTokenRef } from "../src/secrets";
import { parseSecretRef } from "@kizuki/core";
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


test("file references preserve literal spaces and exact enrollment without decoding", async () => {
  const directory = h.tempDir("kizuki secret directory "), path = join(directory, "credential with spaces");
  writeFileSync(path, "synthetic-spaced-token", {mode:0o600});
  const ref = `file:${path}`, resolver = tokenResolver(ref, {});
  expect(parseSecretRef(ref)).toEqual({scheme:"file", value:path});
  expect(validTokenRef(ref)).toBe(true);
  await expect(resolver(ref)).resolves.toBe("synthetic-spaced-token");
  await expect(resolver(ref.replaceAll(" ","%20"))).rejects.toThrow("not granted");
  expect(parseSecretRef("file:/literal%20path")).toEqual({scheme:"file",value:"/literal%20path"});
  expect(validTokenRef("file:relative path")).toBe(false);
  chmodSync(path,0o640);
  await expect(tokenResolver(ref,{})(ref)).rejects.toThrow("owner-only regular file");
});

test("file reference spaces do not admit other whitespace or control bytes", () => {
  for (const separator of ["\t","\n","\r","\v","\f","\0","\x01","\x1f","\x7f","\x85","\x9f","\u00a0","\u2003","\u2028","\u2029"]) {
    expect(parseSecretRef(`file:/synthetic/a${separator}b`)).toBeNull();
  }
  for (const invalid of ["file:","file:/synthetic/trailing\n","file:/synthetic/trailing\r\n","env:WITH SPACE","env:TAB\tNAME","env:","https:/synthetic/path"]) expect(parseSecretRef(invalid)).toBeNull();
  expect(parseSecretRef("env:UNCHANGED_NAME")).toEqual({scheme:"env",value:"UNCHANGED_NAME"});
  expect(validTokenRef("env:bad-name")).toBe(false);
});
