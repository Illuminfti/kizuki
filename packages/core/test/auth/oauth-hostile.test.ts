import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  buildAuthorizationUrl,
  parseTokenResponse,
  refreshTokens,
} from "../../src/auth/oauth";
import {
  FakeTransport,
  NOW,
  base64url,
  provider,
  tokenResponse,
  tokenSet,
} from "./helpers";

const NONCE = base64url(new Uint8Array(32).fill(2));

const urlParams = {
  redirect_uri: "http://127.0.0.1:1234/callback",
  state: NONCE,
  code_challenge: "challenge",
};

describe("a hostile authorization URL", () => {
  test("refuses to carry a credential the provider declared as an extra", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          extra_authorization_params: { client_secret: "installed-app" },
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("refuses an endpoint that already carries unreviewed parameters", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          authorization_url: "https://provider.invalid/authorize?prompt=none",
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("refuses an endpoint carrying a fragment", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({ authorization_url: "https://provider.invalid/authorize#x" }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });
});

describe("a hostile token response", () => {
  test.each([
    ["a lifetime past the representable range", 1e18],
    ["a lifetime one second past the range", 8.64e15],
  ])("refuses %s", (_label, expiresIn) => {
    expect(() =>
      parseTokenResponse(
        provider(),
        200,
        tokenResponse({ expires_in: expiresIn }),
        NOW,
      ),
    ).toThrow(OAuthError);
    try {
      parseTokenResponse(
        provider(),
        200,
        tokenResponse({ expires_in: expiresIn }),
        NOW,
      );
    } catch (error) {
      expect((error as OAuthError).code).toBe("invalid_token_response");
    }
  });

  test("refuses an explicit null refresh token instead of keeping the old one", () => {
    expect(() =>
      parseTokenResponse(
        provider(),
        200,
        tokenResponse({ refresh_token: null }),
        NOW,
        tokenSet(),
      ),
    ).toThrow(OAuthError);
  });

  test("a refresh that omits the scope keeps the scope the owner granted", async () => {
    const granted = tokenSet({ scope: "read" });
    const refreshed = await refreshTokens(
      provider({ scopes: ["read", "write", "profile"] }),
      granted,
      new FakeTransport({
        status: 200,
        body: tokenResponse({ scope: undefined }),
      }),
      () => NOW,
    );
    expect(refreshed.scope).toBe("read");
  });
});
