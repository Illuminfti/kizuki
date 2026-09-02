import { describe, expect, test } from "bun:test";
import {
  OAuthError,
  buildAuthorizationUrl,
  parseTokenResponse,
  pkceChallenge,
  refreshTokens,
  revokeToken,
  signInWithBrowser,
} from "../../src/auth/oauth";
import {
  FakeTransport,
  NOW,
  base64url,
  countingRandom,
  fakeIo,
  provider,
  providerWithoutRevocation,
  tokenResponse,
  tokenSet,
} from "./helpers";

const VERIFIER = base64url(new Uint8Array(32).fill(1));
const NONCE = base64url(new Uint8Array(32).fill(2));

function deterministic(): { randomBytes: (length: number) => Uint8Array } {
  return { randomBytes: countingRandom() };
}

describe("authorization URL", () => {
  test("carries the seven fixed parameters and never the client secret", () => {
    const url = new URL(
      buildAuthorizationUrl(provider({ client_secret: "installed-app" }), {
        redirect_uri: "http://127.0.0.1:1234/callback",
        state: NONCE,
        code_challenge: "challenge",
      }),
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.search).not.toContain("installed-app");
  });

  test("appends provider extras", () => {
    const url = new URL(
      buildAuthorizationUrl(
        provider({
          extra_authorization_params: { access_type: "offline", prompt: "consent" },
        }),
        {
          redirect_uri: "http://127.0.0.1:1234/callback",
          state: NONCE,
          code_challenge: "challenge",
        },
      ),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("refuses an extra that would override a fixed parameter", () => {
    expect(() =>
      buildAuthorizationUrl(
        provider({ extra_authorization_params: { state: "attacker" } }),
        {
          redirect_uri: "http://127.0.0.1:1234/callback",
          state: NONCE,
          code_challenge: "challenge",
        },
      ),
    ).toThrow(TypeError);
  });
});

describe("browser sign-in", () => {
  test("exchanges the code for tokens bound to the PKCE verifier", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    const tokens = await flow;

    const listener = transport.listeners[0];
    expect(listener?.closed).toBe(true);
    expect(transport.posts).toEqual([
      {
        url: "https://provider.invalid/token",
        form: {
          grant_type: "authorization_code",
          code: "SENTINEL-CODE",
          redirect_uri: listener?.redirect_uri ?? "",
          client_id: "fixture-client",
          code_verifier: VERIFIER,
        },
      },
    ]);
    expect(tokens).toEqual({
      access_token: "SENTINEL-ACCESS",
      refresh_token: "SENTINEL-REFRESH",
      expires_at: "2026-03-01T11:00:00.000Z",
      scope: "read profile",
      token_type: "Bearer",
    });

    const opened = new URL(io.opened[0] ?? "");
    expect(opened.searchParams.get("code_challenge")).toBe(
      pkceChallenge(VERIFIER),
    );
    expect(opened.searchParams.get("state")).toBe(NONCE);
    expect(opened.searchParams.get("redirect_uri")).toBe(
      listener?.redirect_uri ?? null,
    );
    expect(io.notifications[0]).toContain(opened.toString());
  });

  test("sends the installed-app secret to the token endpoint only", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const io = fakeIo();
    const flow = signInWithBrowser(
      provider({ client_secret: "installed-app" }),
      io,
      transport,
      { ...deterministic(), now: () => NOW },
    );
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await flow;
    expect(transport.posts[0]?.form["client_secret"]).toBe("installed-app");
    expect(io.opened[0]).not.toContain("installed-app");
  });

  test("omits a client secret the provider declared as empty", async () => {
    const transport = new FakeTransport(
      { status: 200, body: tokenResponse() },
      { status: 200, body: tokenResponse({ access_token: "SENTINEL-SECOND" }) },
      { status: 200, body: null },
    );
    const io = fakeIo();
    // A public client that spells the absent secret as "" must post the same
    // form as one that omits the field: an empty client_secret is a value the
    // provider has to interpret, and some read it as a failed authentication.
    const empty = provider({ client_secret: "" });
    const flow = signInWithBrowser(empty, io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    const tokens = await flow;
    await refreshTokens(empty, tokens, transport, () => NOW);
    await revokeToken(empty, tokens.access_token, transport);

    expect(transport.posts).toHaveLength(3);
    for (const post of transport.posts) {
      expect(Object.keys(post.form)).not.toContain("client_secret");
    }
  });

  test("a failing browser opener does not abort a completed sign-in", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const io = fakeIo({ openUrl: () => Promise.reject(new Error("no browser")) });
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await expect(flow).resolves.toMatchObject({ token_type: "Bearer" });
  });

  test("a browser opener that never resolves does not block completion", async () => {
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const io = fakeIo({ openUrl: () => new Promise<void>(() => undefined) });
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await expect(flow).resolves.toMatchObject({ token_type: "Bearer" });
  });

  test("a mismatched state nonce never reaches the token endpoint", async () => {
    const transport = new FakeTransport();
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: "forged" });
    await expect(flow).rejects.toMatchObject({ code: "state_mismatch" });
    expect(transport.posts).toEqual([]);
    expect(transport.listeners[0]?.closed).toBe(true);
  });

  test("a consent refusal surfaces the provider error code alone", async () => {
    const transport = new FakeTransport();
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ error: "access_denied", state: NONCE });
    await expect(flow).rejects.toThrow("access_denied");
    expect(transport.posts).toEqual([]);
  });

  test("a callback without a code is a provider error", async () => {
    const transport = new FakeTransport();
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ state: NONCE });
    await expect(flow).rejects.toMatchObject({ code: "provider_error" });
  });

  test("gives up when the owner never returns", async () => {
    const transport = new FakeTransport();
    const io = fakeIo();
    await expect(
      signInWithBrowser(provider(), io, transport, {
        ...deterministic(),
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(transport.listeners[0]?.closed).toBe(true);
  });

  test("refuses to run without a client id", async () => {
    const transport = new FakeTransport();
    await expect(
      signInWithBrowser(provider({ client_id: "" }), fakeIo(), transport),
    ).rejects.toThrow(TypeError);
    expect(transport.listeners).toEqual([]);
  });

  test("a rejecting transport becomes a transport error", async () => {
    const transport = new FakeTransport(new Error("socket closed"));
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });
    await expect(flow).rejects.toMatchObject({ code: "transport" });
  });
});

describe("token response parsing", () => {
  test("rejects a token endpoint failure without echoing the body", () => {
    expect(() =>
      parseTokenResponse(
        provider(),
        500,
        { error: "server_error", detail: "SENTINEL-ACCESS" },
        NOW,
      ),
    ).toThrow("server_error");
  });

  test.each([
    ["an empty document", {}],
    ["a null body", null],
    ["a non-bearer token type", tokenResponse({ token_type: "MAC" })],
    ["a non-positive lifetime", tokenResponse({ expires_in: 0 })],
    ["a non-string access token", tokenResponse({ access_token: 7 })],
    ["a numeric refresh token", tokenResponse({ refresh_token: 1 })],
  ])("refuses %s", (_label, body) => {
    expect(() => parseTokenResponse(provider(), 200, body, NOW)).toThrow(
      OAuthError,
    );
    try {
      parseTokenResponse(provider(), 200, body, NOW);
    } catch (error) {
      expect((error as OAuthError).code).toBe("invalid_token_response");
    }
  });

  test("defaults the granted scope to the requested scopes", () => {
    const parsed = parseTokenResponse(
      provider(),
      200,
      tokenResponse({ scope: undefined }),
      NOW,
    );
    expect(parsed.scope).toBe("read profile");
  });
});

describe("refresh", () => {
  test("keeps the stored refresh token when the provider omits it", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({ access_token: "second", refresh_token: undefined }),
    });
    const refreshed = await refreshTokens(
      provider(),
      tokenSet(),
      transport,
      () => NOW,
    );
    expect(refreshed.access_token).toBe("second");
    expect(refreshed.refresh_token).toBe("SENTINEL-REFRESH");
    expect(transport.posts[0]?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "SENTINEL-REFRESH",
      client_id: "fixture-client",
    });
  });

  test("takes the rotated refresh token when the provider sends one", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({ refresh_token: "SENTINEL-ROTATED" }),
    });
    const refreshed = await refreshTokens(
      provider(),
      tokenSet(),
      transport,
      () => NOW,
    );
    expect(refreshed.refresh_token).toBe("SENTINEL-ROTATED");
  });

  test("treats invalid_grant as a rejected refresh", async () => {
    const transport = new FakeTransport({
      status: 400,
      body: { error: "invalid_grant" },
    });
    await expect(
      refreshTokens(provider(), tokenSet(), transport, () => NOW),
    ).rejects.toMatchObject({ code: "refresh_rejected" });
  });

  test("refuses to refresh without a refresh token and makes no request", async () => {
    const transport = new FakeTransport();
    await expect(
      refreshTokens(
        provider(),
        tokenSet({ refresh_token: null }),
        transport,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: "refresh_rejected" });
    expect(transport.posts).toEqual([]);
  });
});

describe("revocation", () => {
  test("accepts a successful revocation", async () => {
    const transport = new FakeTransport({ status: 200, body: {} });
    await expect(
      revokeToken(provider(), "SENTINEL-ACCESS", transport),
    ).resolves.toBeUndefined();
    expect(transport.posts[0]?.url).toBe("https://provider.invalid/revoke");
  });

  test("treats an already-revoked token as revoked", async () => {
    const transport = new FakeTransport({
      status: 400,
      body: { error: "invalid_token" },
    });
    await expect(
      revokeToken(provider(), "SENTINEL-ACCESS", transport),
    ).resolves.toBeUndefined();
  });

  test("says so when the provider has no revocation endpoint", async () => {
    await expect(
      revokeToken(providerWithoutRevocation(), "SENTINEL-ACCESS", new FakeTransport()),
    ).rejects.toMatchObject({ code: "not_supported" });
  });
});
