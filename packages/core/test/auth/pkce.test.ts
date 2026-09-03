import { describe, expect, test } from "bun:test";
import { buildPkce, pkceChallenge } from "../../src/auth/oauth";
import { base64url } from "./helpers";

describe("PKCE", () => {
  test("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("builds a 43 character base64url verifier with its S256 challenge", () => {
    const pkce = buildPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(pkceChallenge(pkce.verifier));
  });

  test("two builds never share a verifier", () => {
    expect(buildPkce().verifier).not.toBe(buildPkce().verifier);
  });

  test("injected randomness makes the pair deterministic", () => {
    const bytes = new Uint8Array(32).fill(7);
    const first = buildPkce(() => bytes);
    const second = buildPkce(() => bytes);
    expect(first).toEqual(second);
    expect(first.verifier).toBe(base64url(bytes));
    expect(first.verifier).toHaveLength(43);
  });

  test("refuses randomness of the wrong length", () => {
    expect(() => buildPkce(() => new Uint8Array(8))).toThrow(TypeError);
  });
});
