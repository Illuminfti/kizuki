import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    expect(sweepStaleCustodyEndpoints(control, own)).toEqual({ removed: [], kept: [live, regular, link].sort(), gone: [] });
  });

  test("an entry that vanishes or fails its probe never aborts the sweep", () => {
    const directory = mkdtempSync(join(tmpdir(), "custody-sweep-race-")); roots.push(directory);
    const control = openControl(directory), api = custodyNative();
    const raced = endpoint("1"), broken = endpoint("2"), stale = endpoint("3");
    for (const name of [raced, broken, stale]) closeSync(api.listen(control, name));
    // Another broker removes one entry between the probe and the unlink; one probe throws.
    const probe = (fd: number, name: string): "refused" | "listening" | "unknown" => {
      if (name === raced) { unlinkSync(join(directory, raced)); return "refused"; }
      if (name === broken) throw new Error("synthetic probe failure");
      return api.probe(fd, name);
    };
    const result = sweepStaleCustodyEndpoints(control, endpoint("a"), probe);
    expect(result.removed.sort()).toEqual([stale]);
    expect(result.gone).toEqual([raced]);
    expect(result.kept).toEqual([broken]);
    expect(readdirSync(directory)).toEqual([broken]);
  });

  test("an unreadable control directory yields an empty sweep instead of a startup failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "custody-sweep-closed-")); roots.push(directory);
    const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    closeSync(control);
    expect(sweepStaleCustodyEndpoints(control, endpoint("a"))).toEqual({ removed: [], kept: [], gone: [] });
  });
});

function openControl(directory: string): number {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  descriptors.push(fd);
  return fd;
}
