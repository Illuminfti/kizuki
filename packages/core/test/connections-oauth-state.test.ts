import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecretResolver } from "../src/contracts/connector";
import type { OAuthProvider } from "../src/auth/oauth";
import { encodeOAuthState, parseOAuthState } from "../src/auth/state";
import type { OAuthState } from "../src/auth/state";
import { createStatePersister } from "../src/ledger/state-persister";
import { LedgerError } from "../src/ledger/connections";
import { enrolled, temporaryDirectories } from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-oauth-state-");

afterEach(cleanup);

describe("OAuth state through the trusted host", () => {
  const provider: OAuthProvider = {
    name: "fixture",
    authorization_url: "https://provider.invalid/authorize",
    token_url: "https://provider.invalid/token",
    client_id: "fixture-client",
    scopes: ["read"],
  };

  function envelope(access: string, refresh: string): OAuthState {
    return {
      schema: "kizuki.oauth-state/v1",
      provider: provider.name,
      account: { id: "acct-ada", display: "ada@example.invalid" },
      tokens: {
        access_token: access,
        refresh_token: refresh,
        expires_at: "2026-03-01T11:00:00.000Z",
        scope: "read",
        token_type: "Bearer",
      },
      written_at: "2026-03-01T10:00:00.000Z",
    };
  }

  test("tokens survive enrollment and refresh without reaching SQLite", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(
      directory,
      encodeOAuthState(envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH")),
    );

    const enrolledState = parseOAuthState(
      store.read(connection) ?? new Uint8Array(),
      provider.name,
    );
    expect(enrolledState.tokens.access_token).toBe("SENTINEL-ACCESS");

    const handle = createStatePersister(db, store, connection);
    await handle.persist(
      encodeOAuthState(envelope("SENTINEL-SECOND", "SENTINEL-ROTATED")),
    );

    const secrets = [
      "SENTINEL-ACCESS",
      "SENTINEL-REFRESH",
      "SENTINEL-SECOND",
      "SENTINEL-ROTATED",
    ];
    const rows = db
      .query<Record<string, unknown>, []>("SELECT * FROM connections")
      .all();
    expect(rows).toHaveLength(1);
    for (const secret of secrets) {
      expect(JSON.stringify(rows)).not.toContain(secret);
    }

    // Closing checkpoints the write-ahead log: a row scan of the main file
    // alone would miss bytes that are still only in ledger.sqlite-wal.
    db.close();
    const artifacts = readdirSync(directory).filter((name) =>
      name.startsWith("ledger.sqlite"),
    );
    expect(artifacts).toContain("ledger.sqlite");
    for (const name of artifacts) {
      const bytes = new TextDecoder().decode(readFileSync(join(directory, name)));
      for (const secret of secrets) {
        expect(bytes).not.toContain(secret);
      }
    }
  });

  test("the host resolver convention hands the connector state as text", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(
      directory,
      encodeOAuthState(envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH")),
    );

    const stateRef = connection.secret_refs[0] ?? "";
    const resolve: SecretResolver = async (ref) => {
      if (ref !== stateRef) {
        throw new LedgerError("connection state resolver refuses other refs");
      }
      return new TextDecoder().decode(store.read(connection) ?? new Uint8Array());
    };

    expect(await resolve(stateRef).then((text) => parseOAuthState(text, provider.name))).toEqual(
      envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH"),
    );
    db.close();
  });
});
