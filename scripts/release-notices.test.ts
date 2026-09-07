import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { BUN_DISTRIBUTION_PIN, createPackageDistribution, distributionHash, distributionIdentity, parsePackageDistribution, verifyDistributionTexts } from "./release-notices";
import { distributionFixture } from "./release-package-fixture";

test.each([false, true])("material integrity is independent of inventory completeness %s and never grants distribution approval", complete => {
  const { distribution, license, notices } = distributionFixture(complete);
  expect(parsePackageDistribution(distribution)).toEqual(distribution);
  expect(() => verifyDistributionTexts(distribution, license, notices)).not.toThrow();
  expect(distribution.distribution_assessment).toBe("not_performed");
  expect(distribution.inventory_status).toBe(complete ? "observed_complete" : "observed_with_unresolved_materials");
  expect(distributionIdentity(distribution).inventory_sha256).toHaveLength(64);
});
test("identity is independent of object key order but binds declarations and unresolved material", () => {
  const { distribution } = distributionFixture();
  expect(distributionIdentity(Object.fromEntries(Object.entries(distribution).reverse()) as typeof distribution)).toEqual(distributionIdentity(distribution));
  const changed = structuredClone(distribution); changed.components[0]!.declared_license = "Synthetic changed declaration";
  expect(distributionIdentity(changed)).not.toEqual(distributionIdentity(distribution));
  expect(distributionIdentity(distributionFixture(true).distribution)).not.toEqual(distributionIdentity(distribution));
});
for (const [label, mutate] of [
  ["unknown root field", (d: any) => { d.approved = true; }],
  ["legal promotion", (d: any) => { d.distribution_assessment = "approved"; }],
  ["wrong runtime revision", (d: any) => { d.bun_revision = "f".repeat(40); }],
  ["wrong runtime text", (d: any) => { d.components[0].source.sha256 = "f".repeat(64); }],
  ["missing runtime", (d: any) => { d.components = []; }],
  ["duplicate component", (d: any) => { d.components.push(structuredClone(d.components[0])); }],
  ["duplicate binary", (d: any) => { d.components[0].binaries = ["kizuki", "kizuki"]; }],
  ["unknown reason", (d: any) => { d.components[0].unresolved = ["approved"]; }],
  ["unresolved status hidden", (d: any) => { d.inventory_status = "observed_complete"; }],
  ["traversal notice", (d: any) => { d.components[0].notice_texts[0].source_path = "../LICENSE"; }],
  ["negative offset", (d: any) => { d.components[0].notice_texts[0].notice_offset = -1; }],
  ["oversized notice", (d: any) => { d.components[0].notice_texts[0].byte_length = 4 * 1024 * 1024 + 1; }],
  ["fractional offset", (d: any) => { d.components[0].notice_texts[0].source_offset = 0.5; }],
  ["duplicate notice", (d: any) => { d.components[0].notice_texts.push(structuredClone(d.components[0].notice_texts[0])); }],
] as const) test(`closed distribution refuses ${label}`, () => {
  const { distribution } = distributionFixture(); mutate(distribution);
  expect(() => parsePackageDistribution(distribution)).toThrow();
});
test("actual pinned Bun original bytes and fragment offsets are verified", () => {
  const { distribution, license, notices } = distributionFixture();
  expect(distributionHash(notices)).toBe(BUN_DISTRIBUTION_PIN.notice_sha256);
  const changed = Buffer.from(notices); changed[0] = changed[0]! ^ 1;
  expect(() => verifyDistributionTexts(distribution, license, changed)).toThrow();
  distribution.third_party_notices_sha256 = distributionHash(changed);
  expect(() => verifyDistributionTexts(distribution, license, changed)).toThrow();
  distribution.third_party_notices_sha256 = distributionHash(notices);
  distribution.components[0]!.notice_texts[0]!.notice_offset = 1;
  expect(() => verifyDistributionTexts(distribution, license, notices)).toThrow();
});

test("real positive-output bundle inputs resolve through module-only package manifests and bind installed manifest bytes", async () => {
  // Both metafiles are generated here by Bun; no positive contribution is fabricated.
  const options = { entrypoints: [Bun.resolveSync("zod/v4", resolve(import.meta.dir, "../packages/mcp"))], target: "bun" as const, metafile: true };
  const cli = await Bun.build(options), mcp = await Bun.build(options);
  expect(cli.success).toBe(true); expect(mcp.success).toBe(true);
  const material = createPackageDistribution(resolve(import.meta.dir, ".."), "a".repeat(40), { kizuki: cli.metafile!, "kizuki-mcp": mcp.metafile! });
  const npm = material.distribution.components.filter(c => c.kind === "npm");
  expect(npm.map(c => c.name)).toEqual(["zod"]);
  expect(npm[0]!.binaries).toEqual(["kizuki", "kizuki-mcp"]);
  expect(npm[0]!.version_or_revision).toBe(JSON.parse(readFileSync(Bun.resolveSync("zod/package.json", resolve(import.meta.dir, "../packages/mcp")), "utf8")).version);
  expect(() => verifyDistributionTexts(material.distribution, material.license, material.notices)).not.toThrow();
});


test("runtime provenance refuses a substituted HTTPS repository despite identical notice bytes", () => {
  const { distribution } = distributionFixture();
  (distribution.components[0]!.source as { url: string }).url = "https://example.com/synthetic/LICENSE.md";
  expect(() => parsePackageDistribution(distribution)).toThrow();
});
test("an identified npm component without text must retain the missing-text reason", () => {
  const { distribution } = distributionFixture(true);
  distribution.components.unshift({ kind: "npm", name: "synthetic", version_or_revision: "1.0.0", declared_license: "MIT",
    source: { kind: "npm", name: "synthetic", version: "1.0.0", integrity: "sha512-" + "A".repeat(86) + "==" },
    binaries: ["kizuki"], input_identity_sha256: "c".repeat(64), notice_texts: [], unresolved: [] });
  expect(() => parsePackageDistribution(distribution)).toThrow();
  distribution.components[0]!.unresolved = ["license_text_missing"];
  distribution.inventory_status = "observed_with_unresolved_materials";
  expect(() => parsePackageDistribution(distribution)).not.toThrow();
});
