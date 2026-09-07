import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connector, enrolled, io, temporaryDirectories } from "./connections-helpers";
import { disconnect, listConnections } from "../src/ledger/connections";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { enrollConnection } from "../src/ledger/enroll";

const { temporary, cleanup } = temporaryDirectories("kizuki-connection-operation-lock-");
afterEach(cleanup);
function start(control: string, mode: string) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "connections-lock-child.ts"), control, mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function firstLine(child: ReturnType<typeof start>) {
  const reader = child.stdout.getReader();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("synthetic child exited before pause");
      buffer += new TextDecoder().decode(chunk.value);
    }
    return JSON.parse(buffer.trim());
  } finally { reader.releaseLock(); }
}
async function result(child: ReturnType<typeof start>) {
  const remaining = async () => {
    const reader = child.stdout.getReader(); let text = "";
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value); } }
    finally { reader.releaseLock(); }
  };
  const [stdout, stderr, code] = await Promise.all([remaining(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout.trim());
}
async function stop(child: ReturnType<typeof start>) { child.kill("SIGKILL"); await child.exited; }
function resume(child: ReturnType<typeof start>, action = "finish") { child.stdin.write(action); child.stdin.end(); }

test("another process cannot recover an active sign-in stage even when its mtime is an hour old", async () => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const winner = start(control, "paused-stage");
  try {
    expect(await firstLine(winner)).toEqual({ phase: "paused", entered: 1 });
    const staged = readdirSync(fixture.store.directory).filter(name => name.endsWith(".tmp"));
    expect(staged).toHaveLength(1);
    const before = readFileSync(join(fixture.store.directory, staged[0]!));
    const loser = await result(start(control, "recover"));
    expect({ recovery_allowed: loser.ok, staged_bytes_retained: existsSync(join(fixture.store.directory, staged[0]!)) }).toEqual({ recovery_allowed: false, staged_bytes_retained: true });
    expect(loser.error).toContain("locked");
    expect(readFileSync(join(fixture.store.directory, staged[0]!))).toEqual(before);
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
    resume(winner);
    expect((await result(winner)).ok).toBe(true);
    expect(readdirSync(fixture.store.directory)).toEqual([fixture.connection.source_key + ".state"]);
  } finally { await stop(winner); fixture.db.close(); }
}, 15_000);

test.each(["paused-timed-out", "paused-caught-write"])("%s keeps exclusion until actual provider settlement and invalidates the writer", async mode => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state"), winner = start(control, mode);
  try {
    const paused = await firstLine(winner);
    expect(paused.entered).toBe(1);
    if (mode === "paused-timed-out") expect(paused.timed_out).toBe(true);
    expect(readdirSync(fixture.store.directory).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
    expect(await result(start(control, "replace"))).toMatchObject({ ok: false, entered: 0 });
    expect((await result(start(control, "recover"))).ok).toBe(false);
    resume(winner);
    if (mode === "paused-timed-out") {
      expect(await firstLine(winner)).toEqual({ phase: "settled", entered: 1 });
      expect(winner.exitCode).toBeNull();
      // This acquisition occurs while the original process is alive, proving
      // actual callback settlement released the fd rather than process death.
      expect((await result(start(control, "recover"))).ok).toBe(true);
      writeFileSync(join(control, "synthetic-settled-exit"), "");
    }
    expect((await result(winner)).ok).toBe(false);
    expect(readdirSync(fixture.store.directory)).toEqual([fixture.connection.source_key + ".state"]);
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
    expect((await result(start(control, "replace")))).toEqual({ ok: true, entered: 1 });
  } finally { await stop(winner); fixture.db.close(); }
}, 15_000);

test.each(["abort", "death"])("%s releases the kernel lease so recovery and another sign-in can proceed", async ending => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const winner = start(control, "paused-stage");
  try {
    await firstLine(winner);
    const lockBefore = lstatSync(join(control, "connection-state.lock"));
    if (ending === "death") await stop(winner);
    else { resume(winner, "abort"); expect((await result(winner)).ok).toBe(false); }
    expect((await result(start(control, "recover"))).ok).toBe(true);
    expect(readdirSync(fixture.store.directory)).toEqual([fixture.connection.source_key + ".state"]);
    expect((await result(start(control, "replace")))).toEqual({ ok: true, entered: 1 });
    expect(lstatSync(join(control, "connection-state.lock")).ino).toBe(lockBefore.ino);
  } finally { await stop(winner); fixture.db.close(); }
}, 15_000);

test("another native database handle can disconnect during the callback and final save still refuses", async () => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const winner = start(control, "paused-fresh-stage");
  try {
    await firstLine(winner);
    // This succeeds while the provider is paused: no SQL transaction spans it.
    disconnect(fixture.db, fixture.connection.connector_id, fixture.connection.source_key);
    resume(winner);
    expect((await result(winner)).ok).toBe(false);
    expect(listConnections(fixture.db)).toEqual([]);
    expect(new TextDecoder().decode(fixture.store.read(fixture.connection)!)).toBe("synthetic original state");
    expect(readdirSync(fixture.store.directory)).toEqual([fixture.connection.source_key + ".state"]);
    expect((await result(start(control, "recover"))).ok).toBe(true);
  } finally { await stop(winner); fixture.db.close(); }
}, 15_000);

test.each(["paused-before-write", "paused-fresh-stage"])("replacing the lock inode during %s prevents publication and never unlocks its successor", async mode => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const previous = start(control, mode);
  let successor: ReturnType<typeof start> | undefined;
  try {
    await firstLine(previous);
    const staged = readdirSync(fixture.store.directory).filter(name => name.endsWith(".tmp"));
    const lock = join(control, "connection-state.lock"), retained = join(control, "synthetic-retained-lock");
    renameSync(lock, retained); writeFileSync(lock, "", { mode: 0o600 });
    successor = start(control, "paused-before-write");
    await firstLine(successor);
    resume(previous);
    const refused = await result(previous);
    expect(refused.ok).toBe(false); expect(refused.error).toContain("custody");
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
    expect(readdirSync(fixture.store.directory).filter(name => name.endsWith(".tmp"))).toEqual(staged);
    expect(await result(start(control, "replace"))).toMatchObject({ ok: false, entered: 0 });
    resume(successor); expect((await result(successor)).ok).toBe(true);
  } finally { await stop(previous); if (successor) await stop(successor); fixture.db.close(); }
}, 15_000);

test("foreign and stale pending handles cannot release an active lease", async () => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state"), other = new ConnectionStateStore(control);
  const pending = fixture.store.beginWithRecovery(fixture.db);
  try {
    other.discard(pending.pending);
    expect(() => other.save(fixture.db, "fixture", pending.pending)).toThrow("minted");
    expect(() => other.begin()).toThrow("locked");
    fixture.store.discard(pending.pending);
    const next = other.beginWithRecovery(fixture.db);
    fixture.store.discard(pending.pending);
    expect(() => fixture.store.begin()).toThrow("locked");
    await expect(pending.writer.write(new Uint8Array())).rejects.toThrow("no longer active");
    other.discard(next.pending);
  } finally { fixture.store.discard(pending.pending); fixture.db.close(); }
});

test.each(["symlink", "hardlink", "mode", "directory", "nonempty"])("an unsafe existing %s lock refuses before the provider callback and is never repaired", async kind => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const lock = join(control, "connection-state.lock"), external = join(temporary(), "synthetic-external");
  writeFileSync(external, "synthetic outside bytes", { mode: 0o600 });
  if (kind === "mode") chmodSync(lock, 0o644);
  else if (kind === "nonempty") writeFileSync(lock, "synthetic unknown bytes");
  else {
    unlinkSync(lock);
    if (kind === "directory") mkdirSync(lock, { mode: 0o700 });
    else if (kind === "hardlink") linkSync(external, lock);
    else symlinkSync(external, lock);
  }
  const before = lstatSync(lock); let called = 0;
  try {
    const candidate = connector(async () => { called++; return { display: "synthetic" }; });
    await expect(enrollConnection(fixture.db, new ConnectionStateStore(control), candidate, io)).rejects.toThrow("custody");
    expect(called).toBe(0); expect(lstatSync(lock).ino).toBe(before.ino); expect(lstatSync(lock).mode).toBe(before.mode);
    expect(readFileSync(external, "utf8")).toBe("synthetic outside bytes");
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
  } finally { fixture.db.close(); }
});

test("discarding a retained handle inside a synchronous verifier prevents save after lease release", async () => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state"), pending = fixture.store.beginWithRecovery(fixture.db);
  try {
    await pending.writer.write(new TextEncoder().encode("synthetic new state"));
    expect(() => fixture.store.save(fixture.db, "fixture", pending.pending, undefined, "1", () => fixture.store.discard(pending.pending))).toThrow();
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
    expect(readdirSync(fixture.store.directory)).toEqual([fixture.connection.source_key + ".state"]);
    expect((await result(start(control, "recover"))).ok).toBe(true);
  } finally { fixture.store.discard(pending.pending); fixture.db.close(); }
});

test.each(["replace", "enroll"])("a competing %s process refuses before any provider callback", async mode => {
  const control = temporary(), fixture = await enrolled(control, "synthetic original state");
  const winner = start(control, "paused-before-write");
  try {
    expect(await firstLine(winner)).toEqual({ phase: "paused", entered: 1 });
    const loser = await result(start(control, mode));
    expect(loser).toMatchObject({ ok: false, entered: 0 });
    expect(loser.error).toContain("locked");
    expect(listConnections(fixture.db)).toEqual([fixture.connection]);
    expect(new TextDecoder().decode(fixture.store.read(fixture.connection)!)).toBe("synthetic original state");
    resume(winner);
    expect((await result(winner)).ok).toBe(true);
  } finally { await stop(winner); fixture.db.close(); }
}, 15_000);
