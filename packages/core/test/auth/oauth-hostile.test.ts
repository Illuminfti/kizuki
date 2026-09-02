import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  buildAuthorizationUrl,
  parseTokenResponse,
  refreshTokens,
  signInWithBrowser,
} from "../../src/auth/oauth";
import {
  FakeTransport,
  NOW,
  base64url,
  countingRandom,
  fakeIo,
  provider,
  tokenResponse,
  tokenSet,
} from "./helpers";

const NONCE = base64url(new Uint8Array(32).fill(2));

function deterministic(): { randomBytes: (length: number) => Uint8Array } {
  return { randomBytes: countingRandom() };
}

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

describe("a sign-in that fails while it is being set up", () => {
  test("a notify that throws leaves no unobserved callback promise", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const io = fakeIo();
      io.notify = (): void => {
        throw new Error("terminal went away");
      };
      await expect(
        signInWithBrowser(provider(), io, new FakeTransport(), deterministic()),
      ).rejects.toThrow("terminal went away");
      // Two drains: the listener rejects its waiter inside close().
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("a listener that will not shut down keeps the real failure", async () => {
    const transport = new FakeTransport();
    transport.listenerCloseError = new Error("listener could not be stopped");
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: "forged" });
    await expect(flow).rejects.toMatchObject({ code: "state_mismatch" });
  });
});
