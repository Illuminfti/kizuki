import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
