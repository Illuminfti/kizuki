import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  buildAuthorizationUrl,
  parseTokenResponse,
  refreshTokens,
  signInWithBrowser,
} from "../../src/auth/oauth";
import { OAuthSession } from "../../src/auth/session";
import { isRfc3339 } from "../../src/util/time";
import {
  FakeTransport,
  NOW,
  base64url,
  countingRandom,
  fakeIo,
  oauthState,
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

  test("refuses an endpoint that carries userinfo credentials", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          authorization_url:
            "https://ada:SENTINEL-PASSWORD@provider.invalid/authorize",
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("refuses an extra whose value is the installed-app secret", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          client_secret: "SENTINEL-SECRET",
          extra_authorization_params: { login_hint: "SENTINEL-SECRET" },
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("refuses an endpoint whose own path carries the secret", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          client_secret: "SENTINEL-SECRET",
          authorization_url: "https://provider.invalid/SENTINEL-SECRET/authorize",
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("a sign-in refuses such an endpoint before it opens a listener", async () => {
    const transport = new FakeTransport();
    await expect(
      signInWithBrowser(
        provider({
          authorization_url:
            "https://ada:SENTINEL-PASSWORD@provider.invalid/authorize",
        }),
        fakeIo(),
        transport,
        { ...deterministic(), timeoutMs: 10 },
      ),
    ).rejects.toThrow(TypeError);
    expect(transport.listeners).toEqual([]);
  });
});

describe("a hostile token response", () => {
  test.each([
    ["a lifetime past the representable range", 1e18],
    ["a lifetime one second past the range", 8.64e15],
    ["a lifetime that outruns a four-digit year", 2.52e11],
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

  test("every accepted lifetime yields an expiry the envelope can hold", () => {
    for (const expiresIn of [1, 3600, 2.4e11, 2.516e11]) {
      const parsed = parseTokenResponse(
        provider(),
        200,
        tokenResponse({ expires_in: expiresIn }),
        NOW,
      );
      expect(isRfc3339(parsed.expires_at)).toBe(true);
    }
  });

  test("a lifetime the envelope cannot hold never displaces durable state", async () => {
    const written: Uint8Array[] = [];
    const session = new OAuthSession({
      provider: provider(),
      state: oauthState({
        tokens: tokenSet({ expires_at: "2026-03-01T10:00:30.000Z" }),
      }),
      transport: new FakeTransport({
        status: 200,
        body: tokenResponse({ access_token: "SENTINEL-SECOND", expires_in: 1e12 }),
      }),
      persist: async (bytes) => {
        written.push(bytes);
      },
      now: () => NOW,
    });
    await expect(session.accessToken()).rejects.toMatchObject({
      code: "invalid_token_response",
    });
    expect(written).toEqual([]);
    expect(session.tokens().access_token).toBe("SENTINEL-ACCESS");
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

  test("a listener that will not shut down keeps the completed grant", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    transport.listenerCloseError = new Error("listener could not be stopped");
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await expect(flow).resolves.toMatchObject({
      access_token: "SENTINEL-ACCESS",
      refresh_token: "SENTINEL-REFRESH",
    });
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

describe("errors leaving the module", () => {
  test("a transport failure names the provider, not the transport", async () => {
    const transport = new FakeTransport(
      new OAuthError("transport", "loopback", "response exceeded the size cap"),
    );
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    const error = await flow.then(
      () => {
        throw new Error("sign-in was expected to fail");
      },
      (reason: unknown) => reason as OAuthError,
    );
    expect(error.provider).toBe("fixture");
    expect(error.code).toBe("transport");
    expect(error.message).toContain("response exceeded the size cap");
  });

  test("a closed listener reports the provider the caller asked for", async () => {
    const transport = new FakeTransport();
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      timeoutMs: 5,
    });
    await expect(flow).rejects.toMatchObject({
      code: "timeout",
      provider: "fixture",
    });
  });
});
