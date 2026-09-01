import { describe, expect, test } from "bun:test";
import * as core from "../src/index";

describe("public surface", () => {
  test("re-exports every runtime value the contract layer defines", () => {
    expect(Object.keys(core).sort()).toEqual([
      "CONNECTOR_SCHEMA",
      "EVENT_SCHEMA",
      "HEALTH_STATES",
      "HealthReport",
      "PROPOSAL_KINDS",
      "PROPOSAL_SCHEMA",
      "PROPOSAL_STATUSES",
      "SENSITIVITY_HINTS",
      "SUBJECT_ROLES",
      "accept",
      "canonicalSerialize",
      "computeContentHash",
      "count",
      "isHealthState",
      "isNonEmptyString",
      "isPlainObject",
      "isProducer",
      "isRfc3339",
      "openLedger",
      "purgeEvents",
      "readSince",
      "replay",
      "ulid",
      "validateEventInput",
      "validateProposal",
    ]);
  });

  test("the schema tags are frozen strings", () => {
    expect(core.EVENT_SCHEMA).toBe("kizuki.event/v1");
    expect(core.PROPOSAL_SCHEMA).toBe("kizuki.proposal/v1");
    expect(core.CONNECTOR_SCHEMA).toBe("kizuki.connector/v1");
  });
});
