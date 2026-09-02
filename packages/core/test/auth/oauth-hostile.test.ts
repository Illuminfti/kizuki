import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  parseTokenResponse,
  refreshTokens,
} from "../../src/auth/oauth";
import { FakeTransport, NOW, provider, tokenResponse, tokenSet } from "./helpers";

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
