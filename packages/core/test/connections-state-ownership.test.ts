import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDurableFile } from "../src/ledger/connection-state-files";
import { temporaryDirectories } from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-state-ownership-");
afterEach(cleanup);

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

describe("connection state creation ownership", () => {
  test("exclusive durable creation preserves an existing fixture file", () => {
    const path = join(temporary(), "existing.state");
    writeFileSync(path, "existing fixture bytes", { mode: 0o600 });
    const before = statSync(path);

    expect(() => writeDurableFile(path, new TextEncoder().encode("new bytes"))).toThrow();

    expect(readFileSync(path, "utf8")).toBe("existing fixture bytes");
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mode).toBe(before.mode);
  });

  for (const mode of ["short", "zero", "partial", "sync", "close"] as const) {
    test(`owned durable file handles ${mode} writes and cleanup`, () => {
      const directory = temporary();
      isolated(`
        import { mock } from "bun:test";
        import * as fs from "node:fs";
        import { strict as assert } from "node:assert";
        import { join } from "node:path";
        const path = join(${JSON.stringify(directory)}, "owned.state");
        const mode = ${JSON.stringify(mode)};
        const realOpen = fs.openSync, realWrite = fs.writeSync;
        const realSync = fs.fsyncSync, realClose = fs.closeSync;
        let ownedFd, writes = 0, closes = 0;
        mock.module("node:fs", () => ({ ...fs,
          openSync(pathname, ...args) {
            const fd = realOpen(pathname, ...args);
            if (pathname === path) ownedFd = fd;
            return fd;
          },
          writeSync(fd, bytes, offset, length) {
            if (fd !== ownedFd) return realWrite(fd, bytes, offset, length);
            writes++;
            if (mode === "zero") return 0;
            if (mode === "partial" && writes > 1) throw new Error("synthetic write failure");
            return realWrite(fd, bytes, offset, mode === "short" || mode === "partial" ? 1 : length);
          },
          fsyncSync(fd) {
            if (fd === ownedFd && mode === "sync") throw new Error("synthetic sync failure");
            return realSync(fd);
          },
          closeSync(fd) {
            if (fd === ownedFd) closes++;
            realClose(fd);
            if (fd === ownedFd && mode === "close") throw new Error("synthetic close failure");
          },
        }));
        const { writeDurableFile } = await import(${JSON.stringify(join(import.meta.dir, "../src/ledger/connection-state-files.ts"))});
        const bytes = new TextEncoder().encode("complete fixture bytes");
        if (mode === "short") {
          writeDurableFile(path, bytes);
          assert.deepEqual(fs.readFileSync(path), Buffer.from(bytes));
          assert.equal(fs.statSync(path).mode & 0o777, 0o600);
          assert.ok(writes > 1);
        } else {
          assert.throws(() => writeDurableFile(path, bytes), /synthetic|made no progress/);
          assert.equal(fs.existsSync(path), false);
        }
        assert.equal(closes, 1);
        assert.throws(() => fs.fstatSync(ownedFd), { code: "EBADF" });
      `);
    });
  }

  for (const stage of ["staging", "journal"] as const) {
    test(`store preserves a pre-existing ${stage} fixture through failure and discard`, () => {
      const directory = temporary();
      isolated(`
        import { mock } from "bun:test";
        import * as fs from "node:fs";
        import { strict as assert } from "node:assert";
        import { join } from "node:path";
        const idsModule = ${JSON.stringify(join(import.meta.dir, "../src/util/ulid.ts"))};
        const ids = await import(idsModule), sequence = [];
        mock.module(idsModule, () => ({ ...ids, ulid: () => {
          const id = sequence.shift();
          if (id === undefined) throw new Error("fixture id sequence exhausted");
          return id;
        }}));
        const { ConnectionStateStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/ledger/connection-state.ts"))});
        const { openLedger } = await import(${JSON.stringify(join(import.meta.dir, "../src/ledger/db.ts"))});
        const { listConnections } = await import(${JSON.stringify(join(import.meta.dir, "../src/ledger/connections.ts"))});
        const source = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        const temporaryId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
        const journalId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
        const stage = ${JSON.stringify(stage)};
        const db = openLedger(":memory:"), store = new ConnectionStateStore(${JSON.stringify(directory)});
        sequence.push(source, temporaryId, journalId);
        const enrollment = store.begin();
        const name = source + ".state." + (stage === "staging" ? temporaryId + ".tmp" : journalId + ".journal");
        const path = join(store.directory, name);
        fs.writeFileSync(path, "existing fixture bytes", { mode: 0o600 });
        const before = fs.statSync(path);
        try {
          const write = () => enrollment.writer.write(new TextEncoder().encode("new fixture bytes"));
          if (stage === "staging") await assert.rejects(write, { code: "EEXIST" });
          else {
            await write();
            assert.throws(() => store.save(db, "fixture", enrollment.pending), { code: "EEXIST" });
          }
          assert.deepEqual(listConnections(db), []);
          assert.equal(fs.readFileSync(path, "utf8"), "existing fixture bytes");
          assert.equal(fs.statSync(path).ino, before.ino);
          assert.equal(fs.statSync(path).mode, before.mode);
          assert.deepEqual(fs.readdirSync(store.directory), [name]);
          store.discard(enrollment.pending);
          assert.equal(fs.readFileSync(path, "utf8"), "existing fixture bytes");
          assert.deepEqual(fs.readdirSync(store.directory), [name]);
        } finally { db.close(); }
      `);
    });
  }
});
