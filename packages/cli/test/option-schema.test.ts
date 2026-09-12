import { describe, expect, test } from "bun:test";
import {
  CONNECT_GRANT_SCHEMA,
  CONNECT_RESUME_SCHEMA,
  CONNECT_REVOKE_SCHEMA,
  connectConsentSchema,
  lookupCommandHelp,
} from "../src/option-schema";
import { CONSENT_OPTIONS } from "../src/source-consent";

describe("option schema", () => {
  test("consent schemas list only the options each action parses", () => {
    const grantOptions: readonly string[] = CONNECT_GRANT_SCHEMA.options;
    expect(grantOptions).toEqual(["--source", ...CONSENT_OPTIONS]);
    expect([...CONNECT_GRANT_SCHEMA.flags]).toEqual(["--json"]);
    expect(CONNECT_GRANT_SCHEMA.bounds).toEqual({
      "--source": "KEY",
      "--policy": "FILE",
      "--expected-revision": "N",
      "--operation-id": "ID",
    });
    expect([...CONNECT_REVOKE_SCHEMA.options]).toEqual([
      "--source",
      "--expected-revision",
      "--operation-id",
    ]);
    expect(CONNECT_REVOKE_SCHEMA.bounds).not.toHaveProperty("--policy");
    expect([...CONNECT_RESUME_SCHEMA.options]).toEqual(["--source", "--operation-id"]);
    expect(CONNECT_RESUME_SCHEMA.bounds).toEqual({
      "--source": "KEY",
      "--operation-id": "ID",
    });
    expect("irreversible" in CONNECT_GRANT_SCHEMA).toBe(false);
    expect("irreversible" in CONNECT_REVOKE_SCHEMA).toBe(false);
    expect(CONNECT_RESUME_SCHEMA.irreversible).toBe(true);
    expect(connectConsentSchema("grant")).toBe(CONNECT_GRANT_SCHEMA);
    expect(connectConsentSchema("revoke")).toBe(CONNECT_REVOKE_SCHEMA);
    expect(connectConsentSchema("resume-revocation")).toBe(CONNECT_RESUME_SCHEMA);
    expect(connectConsentSchema("status")).toEqual({
      options: ["--source"],
      flags: ["--json"],
    });
    expect(connectConsentSchema("markdown-folder")).toBeUndefined();
    expect(connectConsentSchema(undefined)).toBeUndefined();
  });

  test("lookup exposes grant, revoke, and resume-revocation help only", () => {
    for (const action of ["grant", "revoke", "resume-revocation"] as const) {
      const topic = lookupCommandHelp("connect", [action]);
      expect(topic?.name).toBe(`connect ${action}`);
      expect(topic?.schema).toBe(connectConsentSchema(action));
    }
    expect(lookupCommandHelp("connect", ["grant", "extra"])).toBeUndefined();
    expect(lookupCommandHelp("connect", ["status"])).toBeUndefined();
    expect(lookupCommandHelp("connect", ["markdown-folder"])).toBeUndefined();
    expect(lookupCommandHelp("connect", [])).toBeUndefined();
    expect(lookupCommandHelp("query", ["grant"])).toBeUndefined();
  });
});
