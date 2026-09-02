import { describe, expect, test } from "bun:test";
import {
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
  tokenResponse,
  tokenSet,
} from "./helpers";

const VERIFIER = base64url(new Uint8Array(32).fill(1));

const SENTINELS = [
  "SENTINEL-CODE",
  "SENTINEL-ACCESS",
  "SENTINEL-REFRESH",
  "SENTINEL-SECRET",
  VERIFIER,
  base64url(new Uint8Array(32).fill(2)),
];

const NONCE = base64url(new Uint8Array(32).fill(2));

/** A leaked secret in a log line is the failure this whole lane guards. */
function expectRedacted(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const rendered = [
    (error as Error).message,
    String(error),
    JSON.stringify(error),
  ];
  for (const text of rendered) {
    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
    }
  }
}

async function captureSignIn(
  transport: FakeTransport,
  query: Record<string, string>,
  definition = provider(),
): Promise<unknown> {
  const io = fakeIo();
  const flow = signInWithBrowser(definition, io, transport, {
    randomBytes: countingRandom(),
    now: () => NOW,
  });
  await io.firstOpen;
  transport.redirect(query);
  return flow.then(
    () => {
      throw new Error("sign-in was expected to fail");
    },
    (error: unknown) => error,
  );
}

/** Only `error` is a provider-chosen code; every other field is a secret. */
const leakyBody = {
  error: "invalid_client",
  code: "SENTINEL-CODE",
  access_token: "SENTINEL-ACCESS",
  refresh_token: "SENTINEL-REFRESH",
};

const OVERLONG_ERROR =
  "the provider put SENTINEL-ACCESS and SENTINEL-REFRESH into its error field";

describe("secrets never reach an error", () => {
  test("a forged callback keeps the code and the nonce out of the error", async () => {
    expectRedacted(
      await captureSignIn(new FakeTransport(), {
        code: "SENTINEL-CODE",
        state: "forged",
      }),
    );
  });

  test("a provider error too long to be a code is dropped entirely", async () => {
    expect(OVERLONG_ERROR.length).toBeGreaterThan(64);
    expectRedacted(
      await captureSignIn(new FakeTransport(), {
        error: OVERLONG_ERROR,
        state: NONCE,
      }),
    );
  });

  test("a failing token exchange never echoes the response", async () => {
    expectRedacted(
      await captureSignIn(new FakeTransport({ status: 500, body: leakyBody }), {
        code: "SENTINEL-CODE",
        state: NONCE,
      }),
    );
  });

  test("an unparsable token response never echoes the response", async () => {
    expectRedacted(
      await captureSignIn(
        new FakeTransport({
          status: 200,
          body: { ...tokenResponse(), token_type: "MAC" },
        }),
        { code: "SENTINEL-CODE", state: NONCE },
      ),
    );
  });

  test("a transport failure carries only the underlying error name", async () => {
    const error = await captureSignIn(
      new FakeTransport(new Error("posting SENTINEL-CODE to the token endpoint")),
      { code: "SENTINEL-CODE", state: NONCE },
    );
    expectRedacted(error);
    expect((error as Error).message).toContain("Error");
  });

  test("a rejected refresh keeps both tokens out of the error", async () => {
    await refreshTokens(
      provider(),
      tokenSet(),
      new FakeTransport({ status: 400, body: leakyBody }),
      () => NOW,
    ).then(
      () => {
        throw new Error("refresh was expected to fail");
      },
      expectRedacted,
    );
  });

  test("a failed revocation keeps the revoked token out of the error", async () => {
    await revokeToken(
      provider(),
      "SENTINEL-ACCESS",
      new FakeTransport({ status: 500, body: leakyBody }),
    ).then(
      () => {
        throw new Error("revocation was expected to fail");
      },
      expectRedacted,
    );
  });

  test("a token endpoint that echoes the code back drops the whole detail", async () => {
    const error = await captureSignIn(
      new FakeTransport({ status: 400, body: { error: "SENTINEL-CODE" } }),
      { code: "SENTINEL-CODE", state: NONCE },
    );
    expectRedacted(error);
    expect((error as Error).message).toBe("fixture: provider_error");
  });

  test("a callback that echoes the PKCE verifier drops the whole detail", async () => {
    const error = await captureSignIn(new FakeTransport(), {
      error: VERIFIER,
      state: NONCE,
    });
    expectRedacted(error);
    expect((error as Error).message).toBe("fixture: provider_error");
  });

  test("a token endpoint that echoes the installed-app secret drops it", async () => {
    expectRedacted(
      await captureSignIn(
        new FakeTransport({ status: 400, body: { error: "SENTINEL-SECRET" } }),
        { code: "SENTINEL-CODE", state: NONCE },
        provider({ client_secret: "SENTINEL-SECRET" }),
      ),
    );
  });

  test("a refresh whose error field is the refresh token drops the detail", async () => {
    await refreshTokens(
      provider(),
      tokenSet(),
      new FakeTransport({ status: 500, body: { error: "SENTINEL-REFRESH" } }),
      () => NOW,
    ).then(
      () => {
        throw new Error("refresh was expected to fail");
      },
      expectRedacted,
    );
  });

  test("a revocation whose error field is the revoked token drops the detail", async () => {
    await revokeToken(
      provider(),
      "SENTINEL-ACCESS",
      new FakeTransport({ status: 500, body: { error: "SENTINEL-ACCESS" } }),
    ).then(
      () => {
        throw new Error("revocation was expected to fail");
      },
      expectRedacted,
    );
  });
});
