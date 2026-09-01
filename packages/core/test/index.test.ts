import { describe, expect, test } from "bun:test";
import * as core from "../src/index";

describe("public surface", () => {
  test("re-exports every runtime value the contract layer defines", () => {
    expect(Object.keys(core).sort()).toEqual([
      "CONNECTOR_SCHEMA",
      "EVENT_SCHEMA",
      "HEALTH_STATES",
      "HealthReport",
      "PAGE_SENSITIVITIES",
      "PAGE_STATUSES",
      "PAGE_TYPES",
      "PROPOSAL_KINDS",
      "PROPOSAL_SCHEMA",
      "PROPOSAL_STATUSES",
      "SENSITIVITY_HINTS",
      "SUBJECT_ROLES",
      "accept",
      "canonicalSerialize",
      "computeContentHash",
      "count",
      "doctorVault",
      "indexEvent",
      "indexPage",
      "initGraph",
      "initSearch",
      "initVault",
      "isHealthState",
      "isNonEmptyString",
      "isPlainObject",
      "isProducer",
      "isRfc3339",
      "neighbors",
      "openLedger",
      "parseFrontmatter",
      "purgeEvents",
      "readSince",
      "rebuildDerived",
      "rebuildGraph",
      "rebuildSearch",
      "removeDoc",
      "replay",
      "search",
      "serializePage",
      "timeline",
      "toFtsQuery",
      "ulid",
      "validateEventInput",
      "validatePage",
      "validateProposal",
      "writePage",
    ]);
  });

  test("the schema tags are frozen strings", () => {
    expect(core.EVENT_SCHEMA).toBe("kizuki.event/v1");
    expect(core.PROPOSAL_SCHEMA).toBe("kizuki.proposal/v1");
    expect(core.CONNECTOR_SCHEMA).toBe("kizuki.connector/v1");
  });
});
