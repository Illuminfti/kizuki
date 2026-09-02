import { describe, expect, test } from "bun:test";
import {
  OAuthError,
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

const VERIFIER = base64url(new Uint8Array(32).fill(1));
const NONCE = base64url(new Uint8Array(32).fill(2));

function deterministic(): { randomBytes: (length: number) => Uint8Array } {
  return { randomBytes: countingRandom() };
}

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

  test("a listener that will not shut down fails the sign-in", async () => {
    // A port still answering on 127.0.0.1 after sign-in returned is an open
    // door nothing else will close. The grant can be made again; reporting
    // success and leaving the listener up cannot be undone.
    const transport = new FakeTransport({ status: 200, body: tokenResponse() });
    transport.listenerCloseError = new Error("listener could not be stopped");
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, {
      ...deterministic(),
      now: () => NOW,
    });
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: NONCE });

    const error = await flow.then(
      () => {
        throw new Error("sign-in was expected to fail");
      },
      (reason: unknown) => reason as OAuthError,
    );
    expect(error.code).toBe("transport");
    expect(error.provider).toBe("fixture");
    for (const text of [error.message, String(error), JSON.stringify(error)]) {
      expect(text).not.toContain("SENTINEL-ACCESS");
      expect(text).not.toContain("SENTINEL-CODE");
    }
  });

  test("a listener that will not shut down keeps the real failure", async () => {
    const transport = new FakeTransport();
    transport.listenerCloseError = new Error("listener could not be stopped");
    const io = fakeIo();
    const flow = signInWithBrowser(provider(), io, transport, deterministic());
    await io.firstOpen;
    transport.redirect({ code: "SENTINEL-CODE", state: "forged" });
    // The shutdown failed too, but the forged state is what the owner has to
    // act on, so it is what surfaces.
    await expect(flow).rejects.toMatchObject({ code: "state_mismatch" });
    expect(transport.listeners[0]?.closed).toBe(false);
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
    expect(error.message).toBe("fixture: transport: OAuthError");
  });

  test.each([
    [
      "the endpoint it could not reach",
      new OAuthError("transport", "loopback", "POST https://provider.invalid/token"),
    ],
    [
      "a slice of the response body",
      new OAuthError("provider_error", "loopback", "grant for ada@example.invalid"),
    ],
    ["a plain error of its own", new TypeError("connect ECONNREFUSED 10.0.0.7:443")],
  ])("a transport may not report %s", async (_label, thrown) => {
    // The transport is a seam a provider package fills. Whatever it puts in
    // its own error may be a URL, a fragment of the provider's answer or the
    // owner's private text, so only the name of the error crosses this line.
    const transport = new FakeTransport(thrown);
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
    expect(error.code).toBe("transport");
    for (const text of [error.message, String(error), JSON.stringify(error)]) {
      expect(text).not.toContain("provider.invalid");
      expect(text).not.toContain("ada@example.invalid");
      expect(text).not.toContain("10.0.0.7");
    }
  });

  test("a refresh reports a transport failure by name alone", async () => {
    const transport = new FakeTransport(
      new OAuthError("transport", "loopback", "POST https://provider.invalid/token"),
    );
    await expect(
      refreshTokens(provider(), tokenSet(), transport, () => NOW),
    ).rejects.toMatchObject({
      code: "transport",
      message: "fixture: transport: OAuthError",
    });
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
