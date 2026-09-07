import { afterEach, describe, expect, test } from "bun:test";
import { OAuthError, signInWithBrowser } from "../../src/auth/oauth";
import type { LoopbackListener } from "../../src/auth/oauth";
import { loopbackTransport } from "../../src/auth/loopback";
import { fakeIo, provider } from "./helpers";

const open: LoopbackListener[] = [];

afterEach(async () => {
  for (const listener of open.splice(0)) await listener.close();
});

async function listener(): Promise<LoopbackListener> {
  const opened = await loopbackTransport().listen("/callback");
  open.push(opened);
  return opened;
}

describe("loopback redirect listener", () => {
  test("binds an ephemeral port on the loopback interface", async () => {
    const opened = await listener();
    expect(opened.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(Number(new URL(opened.redirect_uri).port)).toBeGreaterThan(0);
  });

  test("binds the exact configured redirect before accepting a callback", async () => {
    const reserved = await listener();
    const redirectUri = reserved.redirect_uri;
    await reserved.close();

    const opened = await loopbackTransport({ redirectUri }).listen("/callback");
    open.push(opened);
    expect(opened.redirect_uri).toBe(redirectUri);
    const pending = opened.callback();
    const wrongPath = new URL("/other?code=wrong", redirectUri);
    expect((await fetch(wrongPath)).status).toBe(404);
    expect((await fetch(redirectUri, { method: "POST" })).status).toBe(404);
    const response = await fetch(`${redirectUri}?code=accepted&state=nonce`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("accepted");
    expect((await pending).searchParams.get("code")).toBe("accepted");
    await opened.close();
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  test.each([
    "",
    "https://127.0.0.1:1234/callback",
    "HTTP://127.0.0.1:1234/callback",
    "http://localhost:1234/callback",
    "http://[::1]:1234/callback",
    "http://0.0.0.0:1234/callback",
    "http://127.1:1234/callback",
    "http://2130706433:1234/callback",
    "http://0177.0.0.1:1234/callback",
    "http://127.0.0.1.:1234/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:01234/callback",
    "http://127.0.0.1:+1234/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:123456/callback",
    "http://127.0.0.1:1234/other",
    "http://127.0.0.1:1234/callback/",
    "http://127.0.0.1:1234/%63allback",
    "http://127.0.0.1:1234/other/../callback",
    "http://127.0.0.1:1234/callback?code=SENTINEL-PRIVATE",
    "http://127.0.0.1:1234/callback?",
    "http://127.0.0.1:1234/callback#fragment",
    "http://127.0.0.1:1234/callback#",
    "http://SENTINEL-PRIVATE@127.0.0.1:1234/callback",
    " http://127.0.0.1:1234/callback",
    "http://127.0.0.1:1234/callback\n",
    "http://127.0.0.1:1234/call\tback",
  ])("refuses a noncanonical fixed redirect at construction: %j", (redirectUri) => {
    expect(() => loopbackTransport({ redirectUri })).toThrow(TypeError);
    expect(() => loopbackTransport({ redirectUri })).toThrow(
      "redirectUri must be http://127.0.0.1:<port>/callback with port 1-65535",
    );
  });

  test.each([1, 80, 65535])(
    "accepts explicit valid port %i without binding yet",
    (port) => {
      expect(() =>
        loopbackTransport({ redirectUri: `http://127.0.0.1:${port}/callback` }),
      ).not.toThrow();
    },
  );

  test("refuses a fixed redirect path mismatch before attempting the bind", async () => {
    const occupied = await listener();
    const transport = loopbackTransport({ redirectUri: occupied.redirect_uri });
    await expect(transport.listen("/other")).rejects.toThrow(TypeError);
    expect((await fetch(occupied.redirect_uri)).status).toBe(200);
  });

  test("refuses an occupied fixed port before browser or provider work", async () => {
    const occupied = await listener();
    const transport = loopbackTransport({ redirectUri: occupied.redirect_uri });
    const io = fakeIo();
    let posted = 0;
    await expect(
      signInWithBrowser(provider(), io, {
        async listen(path) {
          const opened = await transport.listen(path);
          open.push(opened);
          return opened;
        },
        async postForm() {
          posted += 1;
          throw new Error("unexpected token exchange");
        },
      }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(io.opened).toEqual([]);
    expect(io.notifications).toEqual([]);
    expect(posted).toBe(0);
    expect((await fetch(occupied.redirect_uri)).status).toBe(200);
  });

  test("keeps custom callback paths available for ephemeral listeners", async () => {
    const opened = await loopbackTransport().listen("/custom-callback");
    open.push(opened);
    expect(new URL(opened.redirect_uri).pathname).toBe("/custom-callback");
    expect((await fetch(`${opened.redirect_uri}?code=custom`)).status).toBe(200);
    expect((await opened.callback()).searchParams.get("code")).toBe("custom");
  });

  test.each([
    ["userinfo that moves the host off the box", "@evil.invalid/callback"],
    ["a protocol-relative host", "//evil.invalid/callback"],
    ["a query", "/callback?code=planted"],
    ["an unrooted path", "callback"],
  ])("refuses to listen on %s", async (_label, path) => {
    await expect(loopbackTransport().listen(path)).rejects.toThrow(TypeError);
  });

  test("answers the redirect with a page that never echoes the query", async () => {
    const opened = await listener();
    const pending = opened.callback();
    const response = await fetch(`${opened.redirect_uri}?code=abc&state=xyz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await response.text();
    expect(page).toContain("Sign-in received.");
    expect(page).not.toContain("abc");
    expect(page).not.toContain("xyz");

    const landed = await pending;
    expect(landed.searchParams.get("code")).toBe("abc");
    expect(landed.searchParams.get("state")).toBe("xyz");
  });

  test("ignores every other path and method", async () => {
    const opened = await listener();
    const base = new URL(opened.redirect_uri);
    const other = await fetch(new URL("/other", base));
    expect(other.status).toBe(404);
    expect(await other.text()).toBe("");

    const posted = await fetch(opened.redirect_uri, { method: "POST" });
    expect(posted.status).toBe(404);
  });

  test("keeps the first callback when the browser reloads the page", async () => {
    const opened = await listener();
    const pending = opened.callback();
    await fetch(`${opened.redirect_uri}?code=first&state=xyz`);
    const second = await fetch(`${opened.redirect_uri}?code=second&state=xyz`);

    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Sign-in received.");
    expect((await pending).searchParams.get("code")).toBe("first");
  });

  test("closing releases the port and rejects a later callback", async () => {
    const opened = await loopbackTransport().listen("/callback");
    const target = opened.redirect_uri;
    await opened.close();

    await expect(fetch(target)).rejects.toThrow();
    await expect(opened.callback()).rejects.toMatchObject({ code: "timeout" });
  });

  test("closing rejects a callback that is already waiting", async () => {
    const opened = await loopbackTransport().listen("/callback");
    const pending = opened.callback().catch((error: unknown) => error);
    await opened.close();
    expect(await pending).toBeInstanceOf(OAuthError);
  });
});

describe("token endpoint posts", () => {
  test("sends form-encoded fields and returns the parsed document", async () => {
    const request_seen: { form: Record<string, string>; contentType: string | null } =
      { form: {}, contentType: null };
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request): Promise<Response> {
        request_seen.contentType = request.headers.get("content-type");
        request_seen.form = Object.fromEntries(
          new URLSearchParams(await request.text()),
        );
        return Response.json({ access_token: "granted" }, { status: 200 });
      },
    });
    try {
      const result = await loopbackTransport().postForm(
        `http://127.0.0.1:${endpoint.port}/token`,
        { grant_type: "refresh_token", refresh_token: "opaque" },
      );
      expect(result).toEqual({ status: 200, body: { access_token: "granted" } });
      expect(request_seen.contentType).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(request_seen.form).toEqual({
        grant_type: "refresh_token",
        refresh_token: "opaque",
      });
    } finally {
      await endpoint.stop(true);
    }
  });

  test("refuses a response body past the size cap", async () => {
    const oversize = "x".repeat(2 * 1024 * 1024);
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => new Response(oversize, { status: 200 }),
    });
    try {
      await expect(
        loopbackTransport().postForm(
          `http://127.0.0.1:${endpoint.port}/token`,
          { grant_type: "refresh_token" },
        ),
      ).rejects.toMatchObject({ code: "transport" });
    } finally {
      await endpoint.stop(true);
    }
  });

  test("reports a non-JSON response as a status with no document", async () => {
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response =>
        new Response("<html>gateway timeout</html>", { status: 504 }),
    });
    try {
      const result = await loopbackTransport().postForm(
        `http://127.0.0.1:${endpoint.port}/token`,
        { grant_type: "refresh_token" },
      );
      expect(result).toEqual({ status: 504, body: null });
    } finally {
      await endpoint.stop(true);
    }
  });
});
