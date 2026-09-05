import { expect, test } from "bun:test";
import { createGmailConnector } from "../src/connector";
import { GmailFixture } from "../src/testing";
import { encodeState, parseState, FIELDS, GMAIL_SCOPES } from "../src/state";
import { fileURLToPath } from "node:url";

test("an expired request budget never starts unhandled token work", () => {
  // Isolate the synthetic wall clock and unhandled-rejection listener from the
  // test runner; exercise the public connector, not its private token helper.
  const code = `
    import { createGmailConnector } from ${JSON.stringify(fileURLToPath(new URL("../src/connector.ts", import.meta.url)))};
    import { GmailFixture } from ${JSON.stringify(fileURLToPath(new URL("../src/testing.ts", import.meta.url)))};
    import { FIELDS } from ${JSON.stringify(fileURLToPath(new URL("../src/state.ts", import.meta.url)))};
    const f = new GmailFixture(1), realNow = Date.now;
    let shift = 0, unhandled = 0;
    process.on('unhandledRejection', () => { unhandled++; });
    const c = createGmailConnector({client:{id:'synthetic'},secret_ref:'file:synthetic',fields:FIELDS}, {
      now:f.now,persist:f.persist,fetch:async request => {
        const response = await f.fetch(request);
        if(new URL(request.url).pathname.endsWith('/profile')) shift = 46000;
        return response;
      }
    });
    await c.connect(async () => new TextDecoder().decode(f.state));
    Date.now = () => realNow() + shift;
    try {
      const batch = await c.backfill(null); await Bun.sleep(20);
      console.log(JSON.stringify({status:batch.status,events:batch.events.length,unhandled}));
    } finally { Date.now = realNow; await c.revoke(); }
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", code], { timeout: 5000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ status: "unavailable", events: 0, unhandled: 0 });
});

test("local close preserves the only rotated refresh token for restart and later expiry", async () => {
  const f = new GmailFixture(1), expired = parseState(f.state);
  expired.oauth.tokens.expires_at = "2020-01-01T00:00:00Z";
  f.state = encodeState(expired);
  let release!: (value: any) => void, entered!: () => void, writes = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const config = { client: { id: "synthetic" }, secret_ref: "file:synthetic", fields: FIELDS };
  const connector = createGmailConnector(config, { now: f.now, fetch: f.fetch,
    persist: async bytes => { writes++; await f.persist(bytes); },
    oauth: { listen: async () => { throw Error("unused"); }, postForm: async () => {
      entered(); return new Promise(resolve => { release = resolve; });
    } },
  });
  const connecting = connector.connect(async () => new TextDecoder().decode(f.state)).then(() => "connected", () => "refused");
  await started;
  await connector.revoke();
  release({ status: 200, body: { access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } });
  expect(await connecting).toBe("refused");
  expect(writes).toBe(1);
  expect(parseState(f.state).oauth.tokens.refresh_token).toBe("synthetic-rotated-refresh");
  await expect(connector.backfill(null)).rejects.toThrow();
  f.advanceDay();
  let refreshes = 0;
  const restarted = createGmailConnector(config, { now: f.now, fetch: f.fetch, persist: f.persist,
    oauth: { listen: async () => { throw Error("unused"); }, postForm: async (_url, form) => {
      expect(form.refresh_token).toBe("synthetic-rotated-refresh"); refreshes++;
      return { status: 200, body: { access_token: "synthetic-next-access", refresh_token: "synthetic-next-refresh", expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } };
    } },
  });
  await restarted.connect(async () => new TextDecoder().decode(f.state));
  expect(refreshes).toBe(1);
  expect((await restarted.backfill(null)).events).toHaveLength(1);
  await restarted.revoke();
});
