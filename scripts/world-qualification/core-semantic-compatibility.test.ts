import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEWED_QUALIFICATIONS } from "./approvals";
import { candidateRegistry } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import {
  coreSemanticCaseInput,
  coreSemanticContract,
  coreSemanticContractSha256,
  coreSemanticCorpus,
  coreSemanticCorpusSha256,
  validateCoreSemanticAssets,
  scoreCoreSemanticRun,
  expectedCoreSemanticReview,
} from "./core-semantic";

const ACTIVE13_INPUTS = [
  ["core17-situation-positive-carmine-map-cabinet", "4170050a60801657c864ebc261e1ac20d609e89e03dbdc34abbbaa501e3fc7e0"],
  ["core16-situation-reported-vermilion-inlet", "aca9a38da35812dbb35e88185fd4b8312d2a9b840fc99336b23a84f78559b5e6"],
  ["core16-situation-historical-mica-harmonic-hold", "8982c2688ea7ded6d2a67429c60d8052d93f3cd8b6a18d8459efa03598d992e5"],
  ["core15-situation-name-negative-juniper-rill", "fd88cb7043a17abf94529f39f18d49a598e76b247a600fdf4ca6b6810bed2367"],
  ["core15-situation-template-negative-unfilled-equipment-card", "1ffc0251b50b6617caf6fc42eb9bb6bed8e3e2b3ec0502a9d3c9eedb69b2d078"],
  ["core15-situation-hypothetical-negative-silver-sluice", "56386b8fe12204e19c5f4cad82de66b5949ee23d2e4dd057eed3102136194740"],
  ["core15-concept-positive-linen-compass", "84d42555a9388f92f9577cb5786bcae0f648e105193cde983341a16182286d52"],
  ["core15-concept-reported-opal-balance", "3ef65775e84ed137beacbf496af6abe20e62a5a6e2abcf9eebf97d870ffaeaa7"],
  ["core15-concept-historical-velvet-register", "fa8c38c10d5b69ec2d80cea2694f4ce78d3e8fbae96d97cdb83d375a7a6d34e7"],
  ["core15-concept-name-negative-umber-dial", "5f51e02fc978bfe1a27b99eb64b6e8ac4130041f44d3771603b8be367b3a0029"],
  ["core15-concept-template-negative-unfilled-glossary-leaf", "8887e9f440134fc5840271b58c30ceeeb0828a0080776a2086324338f70d9fc3"],
  ["core15-concept-hypothetical-negative-frost-loom", "ce1f25dd085695a2bceae1b47eab7e21914c71a5dd8e079f28274754122180b6"],
  ["core19-situation-maintenance-outline-amber-relay-hold", "53d890fe562560974ee4c64ae0a69a0e1eefcf53d7700010554c9219138f00c4"],
] as const;

test("active thirteen qualification cases retain frozen assets and canonical producer inputs", () => {
  validateCoreSemanticAssets();
  expect(coreSemanticCorpus.cases.map(row => row.id)).toEqual(ACTIVE13_INPUTS.map(([id]) => id));
  expect(coreSemanticCorpusSha256).toBe(sha256(readFileSync(new URL("core-semantic-corpus.json", import.meta.url))));
  expect(coreSemanticContractSha256).toBe(sha256(readFileSync(new URL("core-semantic-contract.json", import.meta.url))));
  const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
  expect(coreSemanticCorpus.cases.map(row => [row.id, sha256(canonicalJson(coreSemanticCaseInput(row, registry)))]))
    .toEqual(ACTIVE13_INPUTS.map(row => [...row]));
  expect(sha256(canonicalJson(coreSemanticCorpus.cases.slice(0, 12)))).toBe("37f01372b4209a69e5e9b2e77da1dd5013ce414363f518bc29d09b0f635cca34");
  expect(sha256(canonicalJson(coreSemanticContract.cases.slice(0, 12)))).toBe("dc6aebf4ed060a2232d2a05a1705a955900d7c9a52af3e129710b2f243163009");
  const approval = REVIEWED_QUALIFICATIONS[0]!;
  expect(sha256(readFileSync(join(import.meta.dir, "../fixtures/world-qualification", approval.file)))).toBe(approval.sha256);
  expect(sha256(readFileSync(join(import.meta.dir, "../fixtures/world-qualification", approval.body_review!.file)))).toBe(approval.body_review!.sha256);
});


test("the existing thirteen observed results and independent review remain byte-equivalent under the default method", () => {
  const approval = REVIEWED_QUALIFICATIONS[0]!;
  type Report = Extract<Awaited<ReturnType<typeof import("./run").runQualification>>, { protocol: "core-semantic-v3" }>;
  const report = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/world-qualification", approval.file), "utf8")) as Report;
  const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
  const result = scoreCoreSemanticRun(report.observations, registry, { source_commit: report.source_commit, input_policy: report.input_policy,
    traces: report.traces, wire_adapter: report.wire_adapter, wire_receipts: report.wire_receipts });
  expect(canonicalJson(result)).toBe(canonicalJson(report.core_semantic));
  const review = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/world-qualification", approval.body_review!.file), "utf8"));
  expect(canonicalJson(expectedCoreSemanticReview(approval.sha256, result))).toBe(canonicalJson(review));
});
