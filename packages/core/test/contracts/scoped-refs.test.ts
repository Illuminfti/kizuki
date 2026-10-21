import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { parseScopedRef, SCOPED_REF_KINDS } from "../../src/contracts/scoped-refs";

describe("closed scoped references", () => {
  test("every advertised kind accepts the same canonical random token shape", () => {
    for (const kind of SCOPED_REF_KINDS) {
      const token = randomBytes(32).toString("base64url");
      expect(parseScopedRef({ kind, token })).toEqual({ kind, token });
    }
  });
  test("raw IDs, ambiguous shapes, noncanonical tails and inherited fields are refused", () => {
    const token = randomBytes(32).toString("base64url");
    for (const value of [token, { kind: "page", token, path: "private/page.md" }, { kind: "unknown", token },
      { kind: "page", token: `${token.slice(0, 42)}B` }, { kind: "page", token: `${token}=` },
      Object.create({ kind: "page", token }), { kind: "page", token: "\u200b" + token }]) expect(parseScopedRef(value)).toBeNull();
  });
});
