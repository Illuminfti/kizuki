import { describe, expect, test } from "bun:test";
import {
  buildAuthorizationUrl,
  refreshTokens,
  revokeToken,
  signInWithBrowser,
} from "../../src/auth/oauth";
import { OAuthSession } from "../../src/auth/session";
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
    // whatever the provider's credentials are. Refusing on a value this module
    // generated or joined itself would fail a sign-in for a collision, and a
    // collision with the random nonce would fail it only on some runs.
    const url = buildAuthorizationUrl(
      provider({ client_secret: "read" }),
      urlParams,
    );
    expect(url).toContain("scope=read+profile");
    expect(url).not.toContain("client_secret");
  });

  test.each([
    [
      "an extra parameter",
      { client_secret: "tiny", extra_authorization_params: { login_hint: "tiny" } },
    ],
    [
      "the endpoint path",
      { client_secret: "tiny", authorization_url: "https://provider.invalid/tiny" },
    ],
    ["the client id", { client_secret: "tiny", client_id: "tiny" }],
    ["the redirect path", { client_secret: "tiny", redirect_path: "/tiny" }],
  ])("refuses a short secret the provider itself put in %s", (_label, overrides) => {
    // Length is no excuse in a field the provider authored: nothing else could
    // have put the value there, so there is no accident to protect.
    expect(() => buildAuthorizationUrl(provider(overrides), urlParams)).toThrow(
      TypeError,
    );
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

describe("a provider definition that changes mid-flight", () => {
  test("a sign-in exchanges the code at the endpoint it was checked against", async () => {
    const definition = provider({ client_secret: "installed-app-secret" });
    const { scope: _granted, ...body } = tokenResponse();
    const transport = new FakeTransport({ status: 200, body });
    const io = fakeIo();
    const flow = signInWithBrowser(definition, io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;

    // The owner is at the consent screen; this is the window a caller sharing
    // the object with anything else leaves open.
    definition.token_url = "https://exfil.invalid/token";
    definition.client_secret = "SENTINEL-REPLACEMENT";
    definition.scopes.push("admin");
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });

    const tokens = await flow;
    expect(tokens.scope).toBe("read profile");
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]?.url).toBe("https://provider.invalid/token");
    expect(transport.posts[0]?.form["client_secret"]).toBe("installed-app-secret");
  });

  test("a refresh posts to the endpoint the session was built with", async () => {
    const definition = provider();
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    const session = new OAuthSession({
      provider: definition,
      state: oauthState({ tokens: tokenSet({ expires_at: "2026-03-01T10:00:30.000Z" }) }),
      transport,
      persist: async () => undefined,
      now: () => NOW,
    });

    definition.token_url = "https://exfil.invalid/token";
    await session.accessToken();

    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]?.url).toBe("https://provider.invalid/token");
  });
});

describe("a transport that names a redirect URI off this machine", () => {
  test.each([
    ["another host over https", "https://exfil.invalid/callback"],
    ["another host over http", "http://exfil.invalid/callback"],
    ["a host that merely looks local", "http://127.0.0.1.exfil.invalid/callback"],
  ])("refuses %s before the browser is opened", async (_label, redirectUri) => {
    const io = fakeIo();
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    transport.listenerRedirectUri = redirectUri;

    await expect(
      signInWithBrowser(provider(), io, transport, {
        ...deterministic(),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(TypeError);
    expect(io.opened).toEqual([]);
    expect(transport.posts).toEqual([]);
    // The listener was already open when the URI was judged, so it has to come
    // down with the refusal rather than outlive it.
    expect(transport.listeners).toHaveLength(1);
    expect(transport.listeners[0]?.closed).toBe(true);
  });

  test("still accepts the loopback URI the transport in core builds", async () => {
    const io = fakeIo();
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    transport.listenerRedirectUri = "http://localhost:43210/callback";
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });

    await expect(flow).resolves.toMatchObject({ access_token: "SENTINEL-ACCESS" });
    expect(transport.posts[0]?.form["redirect_uri"]).toBe(
      "http://localhost:43210/callback",
    );
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
