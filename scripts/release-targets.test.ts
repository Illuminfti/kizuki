import { expect, test } from "bun:test";
import { releaseTarget, requireNativeHost, nativeReleaseTarget } from "./release-targets";
test("closed target registry chooses native Linux and macOS arm64 only", () => {
  expect(nativeReleaseTarget("linux", "x64").target).toBe("bun-linux-x64-baseline");
  expect(nativeReleaseTarget("darwin", "arm64").target).toBe("bun-darwin-arm64");
  expect(() => nativeReleaseTarget("darwin", "x64")).toThrow("unsupported");
  expect(() => releaseTarget("bun-darwin-x64")).toThrow("unsupported");
  expect(() => releaseTarget("../../escape")).toThrow("unsupported");
});
test("proof refuses foreign host and target declarations", () => {
  const mac = releaseTarget("bun-darwin-arm64");
  expect(() => requireNativeHost(mac, "linux", "x64")).toThrow("host does not match");
  expect(() => requireNativeHost(mac, "darwin", "x64")).toThrow("host does not match");
  expect(() => requireNativeHost(mac, "darwin", "arm64")).not.toThrow();
  expect(mac.checksum_command).toBe("shasum -a 256 -c SHA256SUMS");
});
