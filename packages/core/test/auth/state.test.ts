import { describe, expect, test } from "bun:test";
import { MAX_CONNECTION_STATE_BYTES } from "../../src/ledger/connection-state";
import { OAuthError } from "../../src/auth/oauth";
import {
  OAUTH_STATE_SCHEMA,
  encodeOAuthState,
  parseOAuthState,
} from "../../src/auth/state";
import { oauthState } from "./helpers";

function encodedObject(
  mutate: (document: Record<string, unknown>) => void,
): string {
  const document = JSON.parse(
    new TextDecoder().decode(encodeOAuthState(oauthState())),
  ) as Record<string, unknown>;
  mutate(document);
  return JSON.stringify(document);
}

describe("oauth state envelope", () => {
  test("round-trips through bytes", () => {
    const state = oauthState();
    expect(parseOAuthState(encodeOAuthState(state), "fixture")).toEqual(state);
  });

  test("round-trips through the text a host resolver returns", () => {
    const state = oauthState();
    const text = new TextDecoder().decode(encodeOAuthState(state));
    expect(parseOAuthState(text, "fixture")).toEqual(state);
  });

  test("writes its keys in a fixed order", () => {
    const text = new TextDecoder().decode(encodeOAuthState(oauthState()));
    expect(text.startsWith(`{"schema":"${OAUTH_STATE_SCHEMA}","provider":`)).toBe(
      true,
    );
    expect(text.endsWith('"written_at":"2026-03-01T10:00:00.000Z"}')).toBe(true);
  });

  test.each([
    ["another schema", encodedObject((d) => (d["schema"] = "kizuki.other/v1"))],
    ["another provider's state", encodedObject((d) => (d["provider"] = "other"))],
    [
      "an account without an id",
      encodedObject((d) => (d["account"] = { id: "", display: "ada" })),
    ],
    [
      "an account with an extra key",
      encodedObject(
        (d) => (d["account"] = { id: "a", display: "b", email: "c" }),
      ),
    ],
    [
      "a non-string refresh token",
      encodedObject((d) => {
        (d["tokens"] as Record<string, unknown>)["refresh_token"] = 1;
      }),
    ],
    [
      "an unparsable expiry",
      encodedObject((d) => {
        (d["tokens"] as Record<string, unknown>)["expires_at"] = "yesterday";
      }),
    ],
    [
      "a non-bearer token type",
      encodedObject((d) => {
        (d["tokens"] as Record<string, unknown>)["token_type"] = "MAC";
      }),
    ],
    ["an unknown top-level key", encodedObject((d) => (d["extra"] = true))],
    ["a missing top-level key", encodedObject((d) => delete d["written_at"])],
    ["a JSON array", "[]"],
    ["text that is not JSON", "not json at all"],
  ])("refuses %s", (_label, text) => {
    expect(() => parseOAuthState(text, "fixture")).toThrow(OAuthError);
    try {
      parseOAuthState(text, "fixture");
    } catch (error) {
      expect((error as OAuthError).code).toBe("invalid_state");
    }
  });

  test("refuses bytes that are not UTF-8", () => {
    expect(() => parseOAuthState(new Uint8Array([0xff, 0xfe]), "fixture")).toThrow(
      OAuthError,
    );
  });

  test("accepts a state whose refresh token was never granted", () => {
    const state = oauthState({
      tokens: { ...oauthState().tokens, refresh_token: null },
    });
    expect(parseOAuthState(encodeOAuthState(state), "fixture")).toEqual(state);
  });

  test("refuses to encode more than the store will hold", () => {
    const state = oauthState({
      account: {
        id: "acct-ada",
        display: "a".repeat(MAX_CONNECTION_STATE_BYTES),
      },
    });
    expect(() => encodeOAuthState(state)).toThrow(RangeError);
  });
});
