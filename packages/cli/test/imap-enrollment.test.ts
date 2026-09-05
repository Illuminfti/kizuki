import { afterEach, describe, expect, test } from "bun:test";
import {
  ConnectionStateStore,
  disconnect,
  freezeManifest,
  getCheckpoint,
  listConnections,
  openLedger,
  writeResumeCursor,
} from "@kizuki/core";
import type { ConnectionStateWriter, Connector, SignInIo } from "@kizuki/core";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assertSameImapIdentity, serializeImapState } from "../../connector-imap/src/state";
import { createImapConnector } from "../../connector-imap/src/connector";
import { FakeImapServer } from "../../connector-imap/src/testing/fake-imap";
import { memoryDialer } from "../../connector-imap/src/testing/memory-dialer";
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  fixtureMailbox,
  fixtureState,
} from "../../connector-imap/src/testing";
import {
  enrollSignedInConnection,
  loadConnector,
  selectConnection,
} from "../src/connections";
import {
  safeImapSignInFailure,
  sanitizedSignInIo,
} from "../src/commands/connect";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";

const { cleanup, tempVault } = createHelpers();
afterEach(cleanup);

function signedInConnector(
  write: (io: SignInIo) => Promise<string>,
): Connector {
  return {
    manifest: () => freezeManifest({
      schema: "kizuki.connector/v1",
      connector_id: "kizuki.imap",
      version: "0.1.0",
      contract_minor: 1,
      implementation: "test",
      allowed_egress: [],
      cursor_schema: "test/v1",
      kinds: ["email"],
      capabilities: { backfill: true, sync: true, tombstones: false, purge: false, fixture: false },
      required_secrets: [],
      auth_modes: ["sign_in"],
      emits_sensitivity_hint: false,
      default_sensitivity: "personal",
      sensitivity_floor: "personal",
    }),
    async signIn(io: SignInIo, writer: ConnectionStateWriter) {
      await writer.write(new TextEncoder().encode(await write(io)));
      return { display: "owner@example.test" };
    },
  } as unknown as Connector;
}

function prompts(values: readonly string[]): SignInIo {
  let index = 0;
  return {
    async prompt(_question, options) {
      if (index === 1) expect(options).toEqual({ secret: true });
      return values[index++] ?? "";
    },
    notify() {},
    async openUrl() {},
  };
}

function credentialFree(error: unknown, canary: string): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      expect(value.message).not.toContain(canary);
      visit(value.cause);
    }
  };
  visit(error);
}

describe("IMAP interactive enrollment", () => {
  test("real IMAP enrollment keeps a password canary out of notices and failures", async () => {
    const canary = "pr435-password-canary";
    const run = async (
      folders: ReturnType<typeof fixtureMailbox>,
      answer: string,
      options: ConstructorParameters<typeof FakeImapServer>[1] = {},
    ) => {
      const setup = tempVault();
      const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
      const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
      const output: string[] = [];
      let index = 0;
      const io: CliIo = {
        env: {}, vaultOverride: null, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
        out: (line) => output.push(line), err: (line) => output.push(line),
        async prompt(_question, promptOptions) {
          const answers = ["mail.acme.example", "", FIXTURE_USERNAME, canary, answer];
          if (index === 3) expect(promptOptions).toEqual({ secret: true });
          return answers[index++] ?? "";
        },
      };
      try {
        const connector = createImapConnector({}, {
          dial: memoryDialer(new FakeImapServer(folders, {
            username: FIXTURE_USERNAME,
            password: canary,
            ...options,
          })),
        });
        const result = await enrollSignedInConnection(
          db, store, connector, sanitizedSignInIo(io),
        ).catch((error: unknown) => safeImapSignInFailure(error));
        return { output, result };
      } finally {
        db.close();
      }
    };

    const folderCanary = await run([
      ...fixtureMailbox(),
      { wire: canary, attributes: ["\\HasNoChildren"], uidvalidity: 99, uidnext: 1, messages: [] },
    ], "");
    expect(folderCanary.output.join("\n")).not.toContain(canary);
    expect(folderCanary.result).not.toBeInstanceOf(Error);

    const answerCanary = await run(fixtureMailbox(), canary);
    expect(answerCanary.output.join("\n")).not.toContain(canary);
    expect(answerCanary.result).toBeInstanceOf(Error);
    credentialFree(answerCanary.result, canary);

    const providerCanary = await run(fixtureMailbox(), "", {
      password: "different-server-password",
      echoCredentialsOnFailure: true,
    });
    expect(providerCanary.output.join("\n")).not.toContain(canary);
    expect(providerCanary.result).toBeInstanceOf(Error);
    credentialFree(providerCanary.result, canary);
  });

  test("refuses a changed mailbox before replacing its state or checkpoint", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const directory = join(setup.vault, ".kizuki", "connections");
    const store = new ConnectionStateStore(directory);
    const state = fixtureState();
    const connectorFor = (candidate: typeof state) => signedInConnector(async () => new TextDecoder().decode(serializeImapState(candidate)));
    try {
      const first = await enrollSignedInConnection(db, store, connectorFor(state), prompts([]));
      writeResumeCursor(db, first.connector_id, first.source_key, "checkpoint");
      const before = store.read(first)!;
      for (const candidate of [
        { ...state, username: "other@example.test" },
        { ...state, host: "other.example.test" },
        { ...state, port: 1993 },
      ]) {
        await expect(enrollSignedInConnection(db, store, connectorFor(candidate), prompts([]), first.source_key, assertSameImapIdentity)).rejects.toThrow("does not match");
        expect(store.read(first)).toEqual(before);
        expect(getCheckpoint(db, first.connector_id, first.source_key)?.cursor).toBe("checkpoint");
        expect(listConnections(db)).toHaveLength(1);
        expect(readdirSync(directory).filter((name) => !name.endsWith(".tmp"))).toHaveLength(1);
      }
      const rotated = await enrollSignedInConnection(db, store, connectorFor({ ...state, password: "rotated" }), prompts([]), first.source_key, assertSameImapIdentity);
      expect(rotated.source_key).toBe(first.source_key);
      expect(getCheckpoint(db, first.connector_id, first.source_key)?.cursor).toBe("checkpoint");
      disconnect(db, first.connector_id, first.source_key);
      const reconnected = await enrollSignedInConnection(db, store, connectorFor({ ...state, password: "again" }), prompts([]), first.source_key, assertSameImapIdentity);
      expect(reconnected.disconnected_at).toBeNull();
      expect(getCheckpoint(db, first.connector_id, first.source_key)?.cursor).toBe("checkpoint");
    } finally { db.close(); }
  });
  test("stores only core-minted opaque sign-in state", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      const connection = await enrollSignedInConnection(
        db,
        store,
        signedInConnector(async (io) => {
          await io.prompt("Username: ");
          return await io.prompt("App password: ", { secret: true });
        }),
        prompts(["owner@example.test", "only-in-opaque-state"]),
      );
      expect(listConnections(db)).toHaveLength(1);
      expect(connection.secret_refs).toHaveLength(1);
      const state = store.read(connection);
      expect(state).not.toBeNull();
      expect(new TextDecoder().decode(state!)).toBe("only-in-opaque-state");
    } finally {
      db.close();
    }
  });

  test("failed sign-in leaves no connection or state file", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const directory = join(setup.vault, ".kizuki", "connections");
    const store = new ConnectionStateStore(directory);
    try {
      await expect(enrollSignedInConnection(
        db,
        store,
        signedInConnector(async () => { throw new Error("sign-in refused"); }),
        prompts([]),
      )).rejects.toThrow("sign-in refused");
      expect(listConnections(db)).toEqual([]);
      expect(Array.from(new Bun.Glob("*").scanSync(directory))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("initial enrollment uses the core guarded sign-in path", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      await expect(enrollSignedInConnection(
        db,
        store,
        signedInConnector(async (io) => {
          await io.openUrl("http://example.test/steal");
          return "unreachable";
        }),
        prompts([]),
      )).rejects.toThrow("connector browser URL must be https or loopback http");
      expect(listConnections(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("re-sign-in atomically reloads opaque state under the same source key", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      const first = await enrollSignedInConnection(
        db, store, signedInConnector(async () => "first-state"), prompts([]),
      );
      const second = await enrollSignedInConnection(
        db, store, signedInConnector(async () => "replacement-state"), prompts([]),
      );
      expect(second.source_key).toBe(first.source_key);
      expect(listConnections(db)).toHaveLength(1);
      const state = store.read(second);
      expect(state).not.toBeNull();
      expect(new TextDecoder().decode(state!)).toBe("replacement-state");
    } finally {
      db.close();
    }
  });

  test("a failed re-sign-in rolls back opaque state and preserves source identity", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      const first = await enrollSignedInConnection(
        db, store, signedInConnector(async () => "known-good-state"), prompts([]),
      );
      await expect(enrollSignedInConnection(
        db,
        store,
        signedInConnector(async () => { throw new Error("provider rejected replacement"); }),
        prompts([]),
        first.source_key,
      )).rejects.toThrow("provider rejected replacement");
      expect(listConnections(db)).toHaveLength(1);
      expect(new TextDecoder().decode(store.read(first)!)).toBe("known-good-state");
    } finally {
      db.close();
    }
  });

  test("re-sign-in reconnects a disconnected source under its original source key", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      const first = await enrollSignedInConnection(
        db, store, signedInConnector(async () => "old-state"), prompts([]),
      );
      disconnect(db, "kizuki.imap", first.source_key);
      const replacement = await enrollSignedInConnection(
        db, store, signedInConnector(async () => "new-state"), prompts([]), first.source_key,
      );
      expect(replacement.source_key).toBe(first.source_key);
      expect(replacement.disconnected_at).toBeNull();
      expect(new TextDecoder().decode(store.read(replacement)!)).toBe("new-state");
    } finally {
      db.close();
    }
  });

  test("loads real IMAP state from the core store and reports connected health", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const store = new ConnectionStateStore(join(setup.vault, ".kizuki", "connections"));
    try {
      const pending = store.begin();
      await pending.writer.write(serializeImapState(fixtureState()));
      const connection = store.save(db, "kizuki.imap", pending.pending);
      const selected = selectConnection(db, store, "kizuki.imap", connection.source_key);
      const fake = new FakeImapServer(fixtureMailbox(), {
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
      });
      const connector = await loadConnector(
        selected,
        store,
        {},
        (_id, config) => createImapConnector(
          config as { secret_ref?: string },
          { dial: memoryDialer(fake) },
        ),
      );
      expect((await connector.health()).state).toBe("ok");
    } finally {
      db.close();
    }
  });
});
