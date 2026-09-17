import { expect, test } from "bun:test";
import { releaseTarget, requireNativeHost, nativeReleaseTarget, selectedReleaseTarget } from "./release-targets";
test("closed target registry chooses native Linux and macOS arm64 only", () => {
  expect(nativeReleaseTarget("linux", "x64").target).toBe("bun-linux-x64-baseline");
  expect(nativeReleaseTarget("darwin", "arm64").target).toBe("bun-darwin-arm64");
  expect(() => nativeReleaseTarget("darwin", "x64")).toThrow("unsupported");
  expect(() => releaseTarget("bun-darwin-x64")).toThrow("unsupported");
  expect(() => releaseTarget("../../escape")).toThrow("unsupported");
});
test.each(["bun-linux-x64-baseline", "bun-darwin-arm64"])("returned release identity %s cannot mutate the closed registry", (name) => {
  const target = releaseTarget(name);
  const original = { ...target };
  for (const key of Object.keys(target)) {
    expect(Reflect.set(target, key, "changed")).toBe(false);
    expect(Reflect.deleteProperty(target, key)).toBe(false);
    expect(Reflect.defineProperty(target, key, { value: "changed" })).toBe(false);
  }
  expect(Reflect.set(target, "extra", "changed")).toBe(false);
  expect(Reflect.setPrototypeOf(target, null)).toBe(false);
  expect(Object.isFrozen(target)).toBe(true);
  expect(releaseTarget(original.target)).toEqual(original);
  expect(nativeReleaseTarget(original.platform, original.arch)).toEqual(original);
  expect(() => releaseTarget("changed")).toThrow("unsupported");
  expect(() => nativeReleaseTarget("changed", original.arch)).toThrow("unsupported");
  expect(() => requireNativeHost(target, original.platform, original.arch)).not.toThrow();
});
test("package selection preserves frozen identity and refuses foreign overrides", () => {
  const previous = process.env.KIZUKI_TARGET;
  try {
    delete process.env.KIZUKI_TARGET;
    const native = nativeReleaseTarget();
    expect(selectedReleaseTarget()).toBe(native);
    process.env.KIZUKI_TARGET = native.target;
    const selected = selectedReleaseTarget();
    expect(Reflect.set(selected, "target", "changed")).toBe(false);
    expect(selectedReleaseTarget()).toBe(native);
    expect(selectedReleaseTarget().target).toBe(native.target);
    process.env.KIZUKI_TARGET = native.platform === "linux" ? "bun-darwin-arm64" : "bun-linux-x64-baseline";
    expect(() => selectedReleaseTarget()).toThrow("host does not match");
    process.env.KIZUKI_TARGET = "";
    expect(() => selectedReleaseTarget()).toThrow("unsupported release target");
  } finally {
    if (previous === undefined) delete process.env.KIZUKI_TARGET;
    else process.env.KIZUKI_TARGET = previous;
  }
});
test("native host validation refuses a forged target identity", () => {
  const linux = releaseTarget("bun-linux-x64-baseline");
  const mac = releaseTarget("bun-darwin-arm64");
  expect(() => requireNativeHost({ ...mac, platform: linux.platform, arch: linux.arch } as typeof linux, "linux", "x64")).toThrow("host does not match");
  expect(() => requireNativeHost({ ...linux }, "linux", "x64")).not.toThrow();
});
test("proof refuses foreign host and target declarations", () => {
  const mac = releaseTarget("bun-darwin-arm64");
  expect(() => requireNativeHost(mac, "linux", "x64")).toThrow("host does not match");
  expect(() => requireNativeHost(mac, "darwin", "x64")).toThrow("host does not match");
  expect(() => requireNativeHost(mac, "darwin", "arm64")).not.toThrow();
  expect(mac.checksum_command).toBe("shasum -a 256 -c SHA256SUMS");
});
