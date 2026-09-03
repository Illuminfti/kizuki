import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConnectionStateWriter,
  Connector,
  SignInIo,
} from "../src/contracts/connector";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { enrollConnection } from "../src/ledger/enroll";
import type { Connection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";

export interface TemporaryDirectories {
  /** A fresh control directory; every one is removed by cleanup(). */
  temporary(): string;
  cleanup(): void;
}

/**
 * Each suite takes its own list, so one file's cleanup can never remove a
 * directory another file is still using.
 */
export function temporaryDirectories(prefix: string): TemporaryDirectories {
  const directories: string[] = [];
  return {
    temporary: (): string => {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    cleanup: (): void => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export function connector(
  signIn: (io: SignInIo, state: ConnectionStateWriter) => Promise<unknown>,
): Connector {
  return {
    manifest: () => ({
      schema: "kizuki.connector/v1",
      connector_id: "fixture",
      version: "1",
      kinds: ["message"],
      capabilities: {
        backfill: false,
        sync: false,
        tombstones: false,
        purge: false,
        fixture: false,
      },
      required_secrets: [],
      emits_sensitivity_hint: false,
      auth_modes: ["sign_in"],
    }),
    health: async () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    backfill: async () => ({ events: [], cursor: null }),
    sync: async () => ({ events: [], cursor: null }),
    revoke: async () => undefined,
    signIn: async (io, state) =>
      signIn(io, state) as Promise<{ display: string }>,
    purgeSource: async () => ({
      subject_id: "",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [],
  };
}

export const io: SignInIo = {
  prompt: async () => "",
  notify: () => undefined,
  openUrl: async () => undefined,
};

export interface EnrolledConnection {
  db: Database;
  store: ConnectionStateStore;
  connection: Connection;
}

/** A connection whose state file already holds `bytes`; the caller closes db. */
export async function enrolled(
  directory: string,
  bytes: Uint8Array | string,
): Promise<EnrolledConnection> {
  const state = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const db = openLedger(join(directory, "ledger.sqlite"));
  const store = new ConnectionStateStore(directory);
  const connection = await enrollConnection(
    db,
    store,
    connector(async (_io, writer) => {
      await writer.write(state);
      return { display: "ada" };
    }),
    io,
  );
  return { db, store, connection };
}
