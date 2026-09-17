import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateMaestroState } from "./verify-maestro";

const pointer = ".maestro/current-law.json";
const task = { id: "lane-example", status: "pending" };
const historical = { id: "tsk-example", status: "superseded", supersededBy: pointer };
const candidate = {
  id: historical.id,
  sourceTaskId: historical.id,
  superseded: true,
  supersededBy: pointer,
};

describe("committed Maestro state validation", () => {
  test("accepts unclaimed lanes and aligned superseded history", () => {
    expect(validateMaestroState([task, historical], [candidate])).toEqual([]);
  });

  for (const field of ["assignee", "claimedAt", "heartbeatAt", "lastHeartbeatAt", "leaseExpiresAt"]) {
    test(`rejects ${field} on tasks and candidates without exposing its value`, () => {
      const value = "synthetic-worker-value";
      for (const [tasks, candidates] of [
        [[{ ...task, [field]: value }], []],
        [[historical], [{ ...candidate, [field]: value }]],
      ]) {
        const errors = validateMaestroState(tasks!, candidates!);
        expect(errors.join("\n")).toContain(field);
        expect(errors.join("\n")).not.toContain(value);
      }
    });
  }

  test("rejects live reservations, duplicate IDs and malformed records", () => {
    expect(validateMaestroState([{ ...task, status: "in_progress" }], [])).not.toEqual([]);
    expect(validateMaestroState([task, task], [])).not.toEqual([]);
    for (const record of [null, [], {}, { id: "", status: "pending" }]) {
      expect(validateMaestroState([record], [])).not.toEqual([]);
      expect(validateMaestroState([historical], [record])).not.toEqual([]);
    }
  });

  test("rejects padded task and candidate IDs without normalizing or exposing them", () => {
    for (const id of [" lane-example", "lane-example ", "\tlane-example", "lane-example\n", "\u00a0lane-example"]) {
      const paddedTask = { ...task, id };
      const paddedCandidate = { ...candidate, id };
      expect(validateMaestroState([paddedTask], [])).toEqual(["task 1: invalid record or id"]);
      expect(validateMaestroState([historical], [paddedCandidate])).toEqual(["candidate 1: invalid record or id"]);
      expect(paddedTask.id).toBe(id);
      expect(paddedCandidate.id).toBe(id);
    }
  });

  test("rejects padded statuses on tasks and candidates without mutating them", () => {
    for (const status of [" in_progress", "in_progress ", "\tin_progress", "in_progress\n", "\u00a0in_progress"]) {
      const paddedTask = { ...task, status };
      const paddedCandidate = { ...candidate, status };
      expect(validateMaestroState([paddedTask], [])).toEqual(["task 1: invalid status"]);
      expect(validateMaestroState([historical], [paddedCandidate])).toEqual([
        "candidate 1: invalid status",
        "candidate 1: candidate status disagrees with source task",
      ]);
      expect(paddedTask.status).toBe(status);
      expect(paddedCandidate.status).toBe(status);
    }
  });

  test("rejects superseded tasks without a replacement even without a candidate", () => {
    for (const supersededBy of [undefined, null, "", " \t", 42]) {
      expect(validateMaestroState([{ ...historical, supersededBy }], [])).toEqual([
        "task 1: missing supersession reference",
      ]);
    }
    expect(validateMaestroState([historical], [])).toEqual([]);
  });

  test("rejects padded supersession references even when candidate and task agree", () => {
    for (const supersededBy of [` ${pointer}`, `${pointer} `, `${pointer}\t`, `\n${pointer}`]) {
      const source = { ...historical, supersededBy };
      const close = { ...candidate, supersededBy };
      expect(validateMaestroState([source], [])).toEqual(["task 1: invalid supersession reference"]);
      expect(validateMaestroState([source], [close])).toContain("task 1: invalid supersession reference");
      expect(source.supersededBy).toBe(supersededBy);
      expect(close.supersededBy).toBe(supersededBy);
    }
  });

  test("accepts done close candidates using the historical task status", () => {
    const closedCandidate = { id: "tsk-closed", sourceTaskId: "tsk-closed" };
    expect(validateMaestroState([{ id: "tsk-closed", status: "done" }], [closedCandidate])).toEqual([]);
    for (const status of ["pending", "in_progress"]) {
      expect(validateMaestroState([{ id: "tsk-closed", status }], [closedCandidate])).not.toEqual([]);
    }
  });

  test("rejects non-boolean superseded flags on done candidates", () => {
    const source = { id: "tsk-closed", status: "done" };
    const close = { id: source.id, sourceTaskId: source.id };
    for (const superseded of ["true", "false", 0, 1, null, {}, []]) {
      const malformed = { ...close, superseded };
      expect(validateMaestroState([source], [malformed])).toEqual([
        "candidate 1: invalid superseded flag",
      ]);
      expect(malformed.superseded).toBe(superseded);
    }
    expect(validateMaestroState([source], [close])).toEqual([]);
    expect(validateMaestroState([source], [{ ...close, superseded: false }])).toEqual([]);
    expect(validateMaestroState([source], [{ ...close, superseded: true }])).not.toEqual([]);
  });

  test("rejects duplicate close candidates for the same task", () => {
    expect(validateMaestroState([historical], [candidate, candidate])).toEqual([
      "candidate 2: duplicate candidate id",
    ]);
  });

  test("rejects orphaned, active and inconsistently superseded close candidates", () => {
    expect(validateMaestroState([], [candidate])).not.toEqual([]);
    expect(validateMaestroState([task], [{ ...candidate, sourceTaskId: task.id }])).not.toEqual([]);
    expect(validateMaestroState([historical], [{ ...candidate, superseded: false }])).not.toEqual([]);
    expect(validateMaestroState([historical], [{ ...candidate, supersededBy: "other.json" }])).not.toEqual([]);
    expect(validateMaestroState([{ id: historical.id, status: "superseded" }], [candidate])).not.toEqual([]);
  });

  test("rejects live reservations even on an aligned superseded candidate", () => {
    expect(validateMaestroState([historical], [{ ...candidate, status: "in_progress" }])).toEqual([
      "candidate 1: live reservation in committed state",
    ]);
  });

  test("rejects explicit candidate status that contradicts its source task", () => {
    const done = { id: historical.id, status: "done" };
    const closed = { id: done.id, sourceTaskId: done.id };
    for (const status of ["pending", "blocked", "done", null, 1, ""]) {
      expect(validateMaestroState([historical], [{ ...candidate, status }])).toEqual([
        "candidate 1: candidate status disagrees with source task",
      ]);
    }
    expect(validateMaestroState([done], [{ ...closed, status: "pending" }])).toEqual([
      "candidate 1: candidate status disagrees with source task",
    ]);
    expect(validateMaestroState([historical], [{ ...candidate, status: "superseded" }])).toEqual([]);
    expect(validateMaestroState([done], [{ ...closed, status: "done" }])).toEqual([]);
    expect(validateMaestroState([done], [closed])).toEqual([]);
  });

  test("CLI rejects non-JSON whitespace lines without changing the ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "maestro-jsonl-"));
    try {
      mkdirSync(join(root, "scripts"));
      const state = join(root, ".maestro", "tasks");
      mkdirSync(join(state, "candidates"), { recursive: true });
      const script = join(root, "scripts", "verify-maestro.ts");
      writeFileSync(script, readFileSync(join(import.meta.dir, "verify-maestro.ts")));
      for (const blank of ["", " \t\r", "\u00a0", "\uFEFF", "\v", "\f"]) {
        const input = `${JSON.stringify(task)}\n${blank}\n`;
        const path = join(state, "tasks.jsonl");
        writeFileSync(path, input);
        const result = spawnSync(process.execPath, [script], {
          encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        const valid = blank === "" || blank === " \t\r";
        expect(result.status).toBe(valid ? 0 : 1);
        expect(result.stdout).toBe(valid ? "Maestro committed state verification passed\n" : "");
        expect(result.stderr).toBe(valid ? "" : "Maestro committed state is missing or malformed\n");
        expect(readFileSync(path, "utf8")).toBe(input);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI rejects invalid UTF-8 in tasks and candidates without rewriting bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "maestro-utf8-"));
    try {
      mkdirSync(join(root, "scripts"));
      const state = join(root, ".maestro", "tasks");
      mkdirSync(join(state, "candidates"), { recursive: true });
      const script = join(root, "scripts", "verify-maestro.ts");
      writeFileSync(script, readFileSync(join(import.meta.dir, "verify-maestro.ts")));
      const taskPath = join(state, "tasks.jsonl");
      const candidatePath = join(state, "candidates", "example.json");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const isValidUtf8 = (bytes: Buffer) => {
        try { decoder.decode(bytes); return true; } catch { return false; }
      };
      for (const target of [taskPath, candidatePath]) {
        for (const bytes of [Buffer.from("日本語 �"), Buffer.from([0xef, 0xbf, 0xbd]),
          Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xc0, 0xaf])]) {
          writeFileSync(taskPath, JSON.stringify(historical) + "\n");
          writeFileSync(candidatePath, JSON.stringify(candidate));
          const record = target === taskPath ? historical : candidate;
          const input = Buffer.concat([
            Buffer.from(JSON.stringify(record).slice(0, -1) + ',"note":"'),
            bytes, Buffer.from('"}\n'),
          ]);
          writeFileSync(target, input);
          const beforeTask = readFileSync(taskPath);
          const beforeCandidate = readFileSync(candidatePath);
          const result = spawnSync(process.execPath, [script], {
            encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
          });
          const valid = isValidUtf8(bytes);
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status).toBe(valid ? 0 : 1);
          expect(result.stdout).toBe(valid ? "Maestro committed state verification passed\n" : "");
          expect(result.stderr).toBe(valid ? "" : "Maestro committed state is missing or malformed\n");
          expect(readFileSync(taskPath)).toEqual(beforeTask);
          expect(readFileSync(candidatePath)).toEqual(beforeCandidate);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const target of ["tasks", "candidate"]) {
    test(`CLI rejects a leading BOM in ${target} without changing bytes`, () => {
      const root = mkdtempSync(join(tmpdir(), "maestro-bom-"));
      try {
        mkdirSync(join(root, "scripts"));
        const state = join(root, ".maestro", "tasks");
        mkdirSync(join(state, "candidates"), { recursive: true });
        const script = join(root, "scripts", "verify-maestro.ts");
        writeFileSync(script, readFileSync(join(import.meta.dir, "verify-maestro.ts")));
        const taskPath = join(state, "tasks.jsonl");
        const candidatePath = join(state, "candidates", "example.json");
        writeFileSync(taskPath, JSON.stringify(historical) + "\n");
        writeFileSync(candidatePath, JSON.stringify(candidate));
        const path = target === "tasks" ? taskPath : candidatePath;
        writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)]));
        const beforeTask = readFileSync(taskPath);
        const beforeCandidate = readFileSync(candidatePath);
        const result = spawnSync(process.execPath, [script], {
          encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("Maestro committed state is missing or malformed\n");
        expect(readFileSync(taskPath)).toEqual(beforeTask);
        expect(readFileSync(candidatePath)).toEqual(beforeCandidate);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("validates the repository ledger and every close candidate", () => {
    const root = join(import.meta.dir, "..", ".maestro", "tasks");
    const tasks = readFileSync(join(root, "tasks.jsonl"), "utf8")
      .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    const candidates = readdirSync(join(root, "candidates"))
      .filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(root, "candidates", name), "utf8")));
    expect(validateMaestroState(tasks, candidates)).toEqual([]);
  });
});
