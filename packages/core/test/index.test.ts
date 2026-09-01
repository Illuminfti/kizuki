import { describe, expect, test } from "bun:test";
import * as core from "../src/index";

describe("public surface", () => {
  test("re-exports every runtime value the contract layer defines", () => {
    expect(Object.keys(core).sort()).toEqual([
      "CONNECTOR_SCHEMA",
      "DEFAULT_GRANT",
      "EVENT_SCHEMA",
      "HEALTH_STATES",
      "HealthReport",
      "OWNER",
      "PAGE_SENSITIVITIES",
      "PAGE_STATUSES",
      "PAGE_TYPES",
      "PROPOSAL_KINDS",
      "PROPOSAL_SCHEMA",
      "PROPOSAL_STATUSES",
      "SENSITIVITY_HINTS",
      "SENSITIVITY_ORDER",
      "SUBJECT_ROLES",
      "TOOLS",
      "accept",
      "addAgent",
      "authenticate",
      "authorize",
      "canonicalSerialize",
      "checkRate",
      "computeContentHash",
      "count",
      "doctorVault",
      "filterServable",
      "getAgent",
      "initAgents",
      "initVault",
      "isHealthState",
      "isNonEmptyString",
      "isPlainObject",
      "isProducer",
      "isRfc3339",
      "listAgents",
      "listAudit",
      "openLedger",
      "parseFrontmatter",
      "purgeEvents",
      "readSince",
      "recordAudit",
      "replay",
      "revokeAgent",
      "rotateToken",
      "serializePage",
      "setGrant",
      "shapeArguments",
      "toolAllowed",
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
