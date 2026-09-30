import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_RAILS, RAIL_IDS, initServe, listSchedules, listRunReceipts, readLease, WRITER_LEASE } from "@kizuki/core";
import { defineRail, openLedger, registerRail } from "@kizuki/core/testing";
import type { CliIo } from "../../src/commands/index";
import { doctorCommand } from "../../src/commands/doctor";
import { serveCommand } from "../../src/commands/serve";
import { createHelpers } from "../helpers";

// These tests run the serve command in process on a real vault; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, tempVault } = createHelpers();
const disposers: (() => void)[] = [];
let calls = 0;

beforeEach(() => { calls = 0; });
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
});

function session() {
  const setup = tempVault();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: setup.env,
    vaultOverride: setup.vault,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    prompt: async () => { throw new Error("unexpected prompt"); },
  };
  const ledger = () => openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const run = async (...args: string[]) => {
    out.length = 0;
    const code = await serveCommand.run(io, args);
    return { code, out: [...out], err: [...err] };
  };
  const doctor = async (...args: string[]) => {
    out.length = 0;
    const code = await doctorCommand.run(io, args);
    return { code, out: [...out], err: [...err] };
  };
  return { run, doctor, ledger };
}

function fixtureRail(id: string, run: () => void = () => { calls += 1; }) {
  disposers.push(registerRail(defineRail({
    id,
    summary: "Fixture rail.",
    period_s: 300,
    jitter_s: 0,
    expects_output: false,
    run: () => { run(); return { status: "ok", events_synced: 1 }; },
  })));
}

describe("a rail registered only in a test", () => {
  test("shipped serve --once output keeps its exact text and JSON bytes", async () => {
    const vault = session();
    const first = await vault.run("--once", "--no-http", "--json");
    expect(first.code).toBe(0);
    expect(first.out).toEqual(['{"schema":"kizuki.cli.serve/v1","status":"ok","data":{"receipts":7,"http":null},"degraded":[],"warnings":[]}']);
    const second = await vault.run("--once", "--no-http");
    expect(second.code).toBe(0);
    expect(second.out).toEqual(["receipts=7"]);
  });

  test("public defaults and serve init include an extension without a second schedule table", () => {
    fixtureRail("fixture-tick");
    const vault = session();
    const db = vault.ledger();
    try {
      initServe(db);
      expect(RAIL_IDS).toContain("fixture-tick");
      expect(DEFAULT_RAILS.find((rail) => rail.rail === "fixture-tick"))
        .toEqual({ rail: "fixture-tick", period_s: 300, jitter_s: 0, enabled: true });
      expect(listSchedules(db).find((rail) => rail.rail === "fixture-tick"))
        .toMatchObject({ period_s: 300, jitter_s: 0, enabled: true });
    } finally { db.close(); }
  });

  test("serve run holds and releases the writer lease for an extension", async () => {
    let holder: number | undefined;
    const vault = session();
    fixtureRail("fixture-tick", () => {
      const db = vault.ledger();
      try { holder = readLease(db, WRITER_LEASE)?.holder_pid; } finally { db.close(); }
    });
    const ran = await vault.run("run", "fixture-tick", "--json");
    expect(ran.code).toBe(0);
    expect(holder).toBe(process.pid);
    const db = vault.ledger();
    try { expect(readLease(db, WRITER_LEASE)).toBeNull(); } finally { db.close(); }
  });

  test("is refused by serve run until it is registered", async () => {
    const vault = session();
    await expect(vault.run("run", "fixture-tick")).rejects.toThrow("serve run <rail>");
    fixtureRail("fixture-tick");
    const ran = await vault.run("run", "fixture-tick", "--json");
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out[0]!).data).toMatchObject({ rail: "fixture-tick", status: "ok", events_synced: 1 });
    expect(calls).toBe(1);
  });

  test("appears in the schedule after serve init and runs under serve --once with a receipt", async () => {
    fixtureRail("fixture-tick");
    const vault = session();
    const once = await vault.run("--once", "--no-http", "--json");
    expect(once.code).toBe(0);
    const db = vault.ledger();
    try {
      const schedule = db.query<{ rail: string; period_s: number; enabled: number }, []>(
        "SELECT rail, period_s, enabled FROM schedules WHERE rail = 'fixture-tick'",
      ).all();
      expect(schedule).toEqual([{ rail: "fixture-tick", period_s: 300, enabled: 1 }]);
      expect(listRunReceipts(db).filter((receipt) => receipt.rail === "fixture-tick").map((receipt) => receipt.status)).toEqual(["ok"]);
      expect(JSON.parse(once.out[0]!).data.receipts).toBe(8);
    } finally { db.close(); }
  });

  test("writes a failed receipt with the error when its run throws", async () => {
    fixtureRail("fixture-boom", () => { throw new Error("fixture rail exploded"); });
    const vault = session();
    const ran = await vault.run("run", "fixture-boom", "--json");
    expect(ran.code).toBe(1);
    expect(JSON.parse(ran.out[0]!).data).toMatchObject({ rail: "fixture-boom", status: "failed", errors: ["fixture rail exploded"] });
    const db = vault.ledger();
    try {
      const receipts = listRunReceipts(db).filter((receipt) => receipt.rail === "fixture-boom");
      expect(receipts.map((receipt) => [receipt.status, receipt.errors])).toEqual([["failed", ["fixture rail exploded"]]]);
    } finally { db.close(); }
  });

  test("is listed by kizuki doctor --json with its own period and health", async () => {
    fixtureRail("fixture-tick");
    const vault = session();
    await vault.run("run", "fixture-tick");
    const report = await vault.doctor("--json");
    const rails = JSON.parse(report.out.join("\n")).data.serve.rails as { rail: string; status: string; period_s: number }[];
    expect(rails.map((rail) => rail.rail)).toEqual([
      "sync", "retrieval-sweep", "purge-sweep", "embed-backfill", "brief", "doctor-sweep", "journal-prune", "fixture-tick",
    ]);
    expect(rails.find((rail) => rail.rail === "fixture-tick")).toMatchObject({ status: "ok", period_s: 300 });
    const text = await vault.doctor();
    expect(text.out.join("\n")).toContain("rail fixture-tick status=ok");
  });

  test("is skipped by serve --once while its schedule is disabled", async () => {
    fixtureRail("fixture-tick");
    const vault = session();
    await vault.run("run", "fixture-tick");
    expect(calls).toBe(1);
    const db = vault.ledger();
    try { db.query("UPDATE schedules SET enabled = 0 WHERE rail = 'fixture-tick'").run(); } finally { db.close(); }
    const once = await vault.run("--once", "--no-http", "--json");
    expect(once.code).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(once.out[0]!).data.receipts).toBe(7);
  });
});
