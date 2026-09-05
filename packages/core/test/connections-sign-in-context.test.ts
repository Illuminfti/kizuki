import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { ConnectionStateWriter } from "../src/contracts/connector";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { enrollConnection } from "../src/ledger/enroll";
import { getConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { connector, io, temporaryDirectories } from "./connections-helpers";

const dirs = temporaryDirectories("kizuki-sign-in-context-");
afterEach(dirs.cleanup);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

test("the host identifies initial enrollment and legacy two-argument sign-in still works", async () => {
  const db = openLedger(":memory:"), store = new ConnectionStateStore(dirs.temporary());
  try {
    const modern = connector(async () => undefined);
    modern.signIn = async (_io, writer, context) => {
      expect(context).toEqual({ mode: "new" });
      await writer.write(bytes("first")); return { display: "synthetic" };
    };
    const first = await enrollConnection(db, store, modern, io);
    const legacy = connector(async (_io, writer) => { await writer.write(bytes("legacy")); return { display: "synthetic" }; });
    const replaced = await store.replace(db, first, legacy, io);
    expect(text(store.read(replaced)!)).toBe("legacy");
    expect(text(store.read(await enrollConnection(db, store, legacy, io))!)).toBe("legacy");
  } finally { db.close(); }
});

test("replacement receives copied prior bytes without changing the verifier snapshot", async () => {
  const db = openLedger(":memory:"), store = new ConnectionStateStore(dirs.temporary());
  try {
    const pending = store.begin(); await pending.writer.write(bytes("original"));
    const first = store.save(db, "fixture", pending.pending), modern = connector(async () => undefined);
    let verified = false;
    modern.signIn = async (_io, writer, context) => {
      expect(context?.mode).toBe("replace");
      if (context?.mode !== "replace") throw Error("missing replacement context");
      expect(text(context.previous_state)).toBe("original");
      context.previous_state.fill(0);
      expect(text(store.read(first)!)).toBe("original");
      await writer.write(bytes("candidate")); return { display: "synthetic" };
    };
    const replaced = await store.replace(db, first, modern, io, (previous, candidate) => {
      verified = true; expect(text(previous)).toBe("original"); expect(text(candidate)).toBe("candidate");
    });
    expect(verified).toBe(true); expect(replaced.source_key).toBe(first.source_key);
    expect(text(store.read(replaced)!)).toBe("candidate");
  } finally { db.close(); }
});

test("a replacement preflight refusal preserves state and terminates its retained writer", async () => {
  const db = openLedger(":memory:"), store = new ConnectionStateStore(dirs.temporary());
  try {
    const pending = store.begin(); await pending.writer.write(bytes("original"));
    const first = store.save(db, "fixture", pending.pending), modern = connector(async () => undefined);
    let retained: ConnectionStateWriter | undefined, browser = 0;
    modern.signIn = async (_io, writer, context) => {
      retained = writer;
      if (context?.mode !== "replace") throw Error("missing replacement context");
      context.previous_state.fill(0); throw Error("synthetic preflight refusal");
    };
    await expect(store.replace(db, first, modern, { ...io, openUrl: async () => { browser++; } })).rejects.toThrow("synthetic preflight refusal");
    expect(browser).toBe(0); expect(getConnection(db, "fixture", first.source_key)).toEqual(first);
    expect(text(store.read(first)!)).toBe("original"); expect(readdirSync(store.directory)).toEqual([`${first.source_key}.state`]);
    await expect(retained!.write(bytes("late"))).rejects.toThrow("no longer active");
  } finally { db.close(); }
});
