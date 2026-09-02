import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  buildAuthorizationUrl,
  parseTokenResponse,
  refreshTokens,
  revokeToken,
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

const VERIFIER = base64url(new Uint8Array(32).fill(1));
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

  test("refuses an endpoint that hides the secret behind percent-encoding", () => {
    // A plain substring test passes here, yet the browser, the referrer header
    // and the provider's access log all read the path decoded.
    expect(() =>
      buildAuthorizationUrl(
        provider({
          client_secret: "SENTINEL-SECRET",
          authorization_url:
            "https://provider.invalid/SENTINEL%2DSECRET/authorize",
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("refuses an extra that hides the secret behind double encoding", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({
          client_secret: "SENTINEL-SECRET",
          extra_authorization_params: { login_hint: "SENTINEL%252DSECRET" },
        }),
        urlParams,
      ),
    ).toThrow(TypeError);
  });

  test("a secret too short to tell from an accident does not abort sign-in", () => {
    // "read" is one of the requested scopes, so the assembled URL contains it
    // whatever the provider's credentials are. Refusing here would fail a
    // sign-in for a collision, and a collision with the random nonce would
    // fail it only on some runs.
    const url = buildAuthorizationUrl(
      provider({ client_secret: "read" }),
      urlParams,
    );
    expect(url).toContain("scope=read+profile");
    expect(url).not.toContain("client_secret");
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

describe("a provider endpoint on a scheme core will not speak", () => {
  test.each([
    ["javascript", "javascript:fetch('https://exfil.invalid')"],
    ["file", "file:///etc/hostname"],
    ["data", "data:text/html,<p>consent</p>"],
    ["ftp", "ftp://provider.invalid/authorize"],
    ["plain http off the loopback", "http://provider.invalid/authorize"],
  ])("refuses %s as the authorization endpoint", (_label, authorization_url) => {
    expect(() =>
      buildAuthorizationUrl(provider({ authorization_url }), urlParams),
    ).toThrow(TypeError);
  });

  test("never opens the browser at a javascript: authorization endpoint", async () => {
    const io = fakeIo();
    const transport = new FakeTransport();
    await expect(
      signInWithBrowser(
        provider({ authorization_url: "javascript:fetch('https://exfil.invalid')" }),
        io,
        transport,
        { ...deterministic(), timeoutMs: 10 },
      ),
    ).rejects.toThrow(TypeError);
    expect(io.opened).toEqual([]);
    expect(transport.listeners).toEqual([]);
  });

  test.each([
    ["plain http", "http://provider.invalid/token"],
    ["file", "file:///etc/hostname"],
  ])("refuses %s as the token endpoint before the code is sent", async (_label, token_url) => {
    const io = fakeIo();
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    await expect(
      signInWithBrowser(provider({ token_url }), io, transport, {
        ...deterministic(),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(TypeError);
    expect(transport.posts).toEqual([]);
    expect(transport.listeners).toEqual([]);
  });

  test("refuses a cleartext token endpoint on refresh", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    await expect(
      refreshTokens(
        provider({ token_url: "http://provider.invalid/token" }),
        tokenSet(),
        transport,
        () => NOW,
      ),
    ).rejects.toThrow(TypeError);
    expect(transport.posts).toEqual([]);
  });

  test("refuses a cleartext revocation endpoint", async () => {
    const transport = new FakeTransport({ status: 200, body: null });
    await expect(
      revokeToken(
        provider({ revocation_url: "http://provider.invalid/revoke" }),
        "SENTINEL-ACCESS",
        transport,
      ),
    ).rejects.toThrow(TypeError);
    expect(transport.posts).toEqual([]);
  });

  test.each([
    ["127.0.0.1", "http://127.0.0.1:8080/token"],
    ["localhost", "http://localhost:8080/token"],
    ["::1", "http://[::1]:8080/token"],
  ])("accepts a fake authorization server on %s", async (_label, token_url) => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const tokens = await refreshTokens(
      provider({ token_url }),
      tokenSet(),
      transport,
      () => NOW,
    );
    expect(tokens.access_token).toBe("SENTINEL-ACCESS");
    expect(transport.posts).toHaveLength(1);
  });
});

describe("a hostile redirect path", () => {
  test.each([
    ["userinfo that moves the host off the box", "@evil.invalid/callback"],
    ["a protocol-relative host", "//evil.invalid/callback"],
    ["a query the listener can never match", "/callback?code=planted"],
    ["a fragment", "/callback#planted"],
    ["a path that is not rooted", "callback"],
  ])("refuses %s", async (_label, redirect_path) => {
    const io = fakeIo();
    const transport = new FakeTransport();
    await expect(
      signInWithBrowser(provider({ redirect_path }), io, transport, {
        ...deterministic(),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(TypeError);
    expect(transport.listeners).toEqual([]);
    expect(io.opened).toEqual([]);
  });

  test("keeps the redirect the owner's browser is sent back to on the box", async () => {
    const io = fakeIo();
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const signedIn = signInWithBrowser(provider(), io, transport, deterministic());
    const opened = await io.firstOpen;
    const redirect = new URL(opened).searchParams.get("redirect_uri") ?? "";
    expect(new URL(redirect).hostname).toBe("127.0.0.1");
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await signedIn;
    expect(transport.posts[0]?.form["redirect_uri"]).toBe(redirect);
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
      ).rejects.toMatchObject({ code: "transport", provider: "fixture" });
      // Two drains: the listener rejects its waiter inside close().
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("a notifier that throws its own text leaks neither URL nor nonce", async () => {
    const io = fakeIo();
    io.notify = (text: string): void => {
      throw new Error(text);
    };
    const failure = await signInWithBrowser(
      provider(),
      io,
      new FakeTransport(),
      deterministic(),
    ).then(
      () => {
        throw new Error("sign-in was expected to fail");
      },
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(OAuthError);
    const error = failure as OAuthError;
    expect(error.code).toBe("transport");
    for (const text of [error.message, String(error), JSON.stringify(error)]) {
      expect(text).not.toContain(NONCE);
      expect(text).not.toContain(VERIFIER);
      expect(text).not.toContain("provider.invalid");
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
