import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custodyNative } from "../../src/util/custody-native";
import { sweepStaleCustodyEndpoints } from "../../src/serve/custody-startup";

const roots: string[] = [];
const descriptors: number[] = [];
afterEach(() => {
  for (const fd of descriptors.splice(0)) { try { closeSync(fd); } catch { /* Already closed by the test. */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const endpoint = (digit: string): string => `custody-${digit.repeat(32)}.sock`;

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("custody endpoint sweep", () => {
  test("only a stale owner-only socket that refuses connections is unlinked", () => {
    const directory = mkdtempSync(join(tmpdir(), "custody-sweep-")); roots.push(directory);
    const control = openControl(directory), api = custodyNative();
    const own = endpoint("a"), stale = endpoint("b"), live = endpoint("c"), regular = endpoint("d"), link = endpoint("e"), other = "unrelated.sock";
    closeSync(api.listen(control, stale));
    closeSync(api.listen(control, own));
    closeSync(api.listen(control, other));
    const listening = api.listen(control, live); descriptors.push(listening);
    writeFileSync(join(directory, regular), "synthetic", { mode: 0o600 });
    symlinkSync(join(directory, stale), join(directory, link));
    expect(api.probe(control, stale)).toBe("refused");
    expect(api.probe(control, live)).toBe("listening");

    const result = sweepStaleCustodyEndpoints(control, own);
    expect(result.removed).toEqual([stale]);
    expect(result.kept.sort()).toEqual([live, regular, link].sort());
    expect(readdirSync(directory).sort()).toEqual([own, live, regular, link, other].sort());
    expect(lstatSync(join(directory, link)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(directory, stale))).toBe(false);
    // The live listener was only probed; it still listens and is kept on every pass.
    expect(api.probe(control, live)).toBe("listening");
    expect(sweepStaleCustodyEndpoints(control, own)).toEqual({ removed: [], kept: [live, regular, link].sort() });
  });
});

function openControl(directory: string): number {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  descriptors.push(fd);
  return fd;
}
