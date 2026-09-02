import { describe, expect, test } from "bun:test";
import { OAuthSession } from "../../src/auth/session";
import { parseOAuthState } from "../../src/auth/state";
import {
  FakeTransport,
  NOW,
  oauthState,
  provider,
  tokenResponse,
  tokenSet,
} from "./helpers";

function recorder(): {
  persist: (bytes: Uint8Array) => Promise<void>;
  written: Uint8Array[];
} {
  const written: Uint8Array[] = [];
  return {
    written,
    persist: async (bytes) => {
      written.push(bytes);
    },
  };
}

const FRESH = oauthState({ tokens: tokenSet({ expires_at: "2026-03-01T11:00:00.000Z" }) });
const NEARLY_EXPIRED = oauthState({
  tokens: tokenSet({ expires_at: "2026-03-01T10:00:30.000Z" }),
});

describe("oauth session", () => {
  test("serves a token that is still comfortably valid without a request", async () => {
    const transport = new FakeTransport();
    const sink = recorder();
    const session = new OAuthSession({
      provider: provider(),
      state: FRESH,
      transport,
      persist: sink.persist,
      now: () => NOW,
    });
    expect(await session.accessToken()).toBe("SENTINEL-ACCESS");
    expect(transport.posts).toEqual([]);
    expect(sink.written).toEqual([]);
  });

  test("refreshes a token that expires inside the skew window", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({ access_token: "SENTINEL-SECOND" }),
    });
    const sink = recorder();
    const session = new OAuthSession({
      provider: provider(),
      state: NEARLY_EXPIRED,
      transport,
      persist: sink.persist,
      now: () => NOW,
    });
    expect(await session.accessToken()).toBe("SENTINEL-SECOND");
    expect(transport.posts).toHaveLength(1);
  });

  test("concurrent callers share one refresh", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({ access_token: "SENTINEL-SECOND" }),
    });
    const sink = recorder();
    const session = new OAuthSession({
      provider: provider(),
      state: NEARLY_EXPIRED,
      transport,
      persist: sink.persist,
      now: () => NOW,
    });
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => session.accessToken()),
    );
    expect(new Set(tokens)).toEqual(new Set(["SENTINEL-SECOND"]));
    expect(transport.posts).toHaveLength(1);
    expect(sink.written).toHaveLength(1);
  });

  test("persists an envelope carrying the rotated refresh token", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({
        access_token: "SENTINEL-SECOND",
        refresh_token: "SENTINEL-ROTATED",
      }),
    });
    const sink = recorder();
    const session = new OAuthSession({
      provider: provider(),
      state: NEARLY_EXPIRED,
      transport,
      persist: sink.persist,
      now: () => NOW,
    });
    await session.refresh();
    const persisted = parseOAuthState(sink.written[0] ?? new Uint8Array(), "fixture");
    expect(persisted.tokens.access_token).toBe("SENTINEL-SECOND");
    expect(persisted.tokens.refresh_token).toBe("SENTINEL-ROTATED");
    expect(persisted.written_at).toBe(NOW.toISOString());
    expect(persisted.account).toEqual(NEARLY_EXPIRED.account);
  });

  test("a persist failure fails the run but keeps the new tokens usable", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: tokenResponse({
        access_token: "SENTINEL-SECOND",
        refresh_token: "SENTINEL-ROTATED",
      }),
    });
    const session = new OAuthSession({
      provider: provider(),
      state: NEARLY_EXPIRED,
      transport,
      persist: () => Promise.reject(new Error("read-only control directory")),
      now: () => NOW,
    });
    await expect(session.refresh()).rejects.toThrow("read-only control directory");
    expect(session.tokens()).toMatchObject({
      access_token: "SENTINEL-SECOND",
      refresh_token: "SENTINEL-ROTATED",
    });
  });

  test("a later refresh runs after a failed one", async () => {
    const transport = new FakeTransport(
      new Error("socket closed"),
      { status: 200, body: tokenResponse({ access_token: "SENTINEL-SECOND" }) },
    );
    const sink = recorder();
    const session = new OAuthSession({
      provider: provider(),
      state: NEARLY_EXPIRED,
      transport,
      persist: sink.persist,
      now: () => NOW,
    });
    await expect(session.refresh()).rejects.toMatchObject({ code: "transport" });
    await session.refresh();
    expect(transport.posts).toHaveLength(2);
  });

  test("forgetting the tokens leaves the session unauthenticated", async () => {
    const session = new OAuthSession({
      provider: provider(),
      state: FRESH,
      transport: new FakeTransport(),
      persist: recorder().persist,
      now: () => NOW,
    });
    session.forget();
    await expect(session.accessToken()).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(() => session.tokens()).toThrow("unauthenticated");
  });
});
