import { expect, test } from "bun:test";
import { BUILD_INFO, describeBuild } from "../src/build-info";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a source run has no build metadata and reports the dev marker", () => {
  expect(BUILD_INFO).toBeNull();
  expect(describeBuild("1.2.3")).toBe("1.2.3 dev");
});

test("a release build reports its version, source revision and build time on one line", () => {
  expect(describeBuild("1.2.3", { sourceSha: SHA, builtAt: "2026-01-02T03:04:05.000Z" })).toBe(
    `1.2.3 source=${SHA} built=2026-01-02T03:04:05.000Z`,
  );
});
