import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CURRENT_LAW_PATH = ".maestro/current-law.json";
const TASKS_PATH = ".maestro/tasks/tasks.jsonl";
const WAVE_BATCH_PATH = ".maestro/tasks/batches/kizuki-waves-20260901.json";
const WAVE_CANDIDATE_PATH = ".maestro/tasks/candidates/tsk-0970f3.json";
const RFC_PATH = "rfcs/0002-autonomous-canon.md";

const BINDING = [
  "rfcs/0002-autonomous-canon.md",
  "docs/CURRENT.md",
  "docs/decision-log.md",
] as const;

const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

interface CurrentLaw {
  id: string;
  binding: string[];
  laneTable: { path: string; section: string };
  supersedesBatch: string;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  type: string;
  status: string;
  currentLaw?: string;
  supersededBy?: string;
  blockedBy?: string[];
}

interface Batch {
  batchId: string;
  superseded?: boolean;
  supersededBy?: string;
  created: { id: string }[];
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8")) as T;
}

function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function loadTasks(): Task[] {
  return readText(TASKS_PATH)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Task);
}

function rfc0002LaneIds(rfc: string): string[] {
  const start = rfc.indexOf("### 18.4 Lanes");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = rfc.slice(start);
  const nextHeading = rest.search(/\n## /);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const ids: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^\| `([a-z0-9-]+)`\s+\|/.exec(line);
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

describe("Maestro current-law ledger", () => {
  const law = readJson<CurrentLaw>(CURRENT_LAW_PATH);
  const tasks = loadTasks();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lanes = rfc0002LaneIds(readText(RFC_PATH));
  const waveBatch = readJson<Batch>(WAVE_BATCH_PATH);
  const waveIds = waveBatch.created.map((row) => row.id);
  const candidate = readJson<{
    id: string;
    superseded?: boolean;
    supersededBy?: string;
  }>(WAVE_CANDIDATE_PATH);
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));

  test("one current-law pointer names the three binding documents and the RFC lane table", () => {
    expect(law.id).toBe("rfc-0002-current-law");
    expect(law.binding).toEqual([...BINDING]);
    expect(law.laneTable).toEqual({ path: RFC_PATH, section: "18.4" });
    expect(law.supersedesBatch).toBe("kizuki-waves-20260901");
    for (const path of law.binding) {
      expect(readText(path).length).toBeGreaterThan(0);
    }
    expect(readText(".maestro/AGENTS.md")).toContain("current-law.json");
  });

  test("Wave 1-6 tasks remain on disk as superseded history, not current architecture", () => {
    expect(waveIds).toEqual([
      "tsk-0970f3",
      "tsk-e5e110",
      "tsk-88cdae",
      "tsk-92ccb7",
      "tsk-563f05",
      "tsk-37c80e",
    ]);
    for (const id of waveIds) {
      const task = byId.get(id);
      expect(task).toBeDefined();
      expect(task?.status).toBe("superseded");
      expect(task?.supersededBy).toBe(CURRENT_LAW_PATH);
    }
    expect(byId.get("tsk-0970f3")?.title).toContain("staging, promote");
    expect(byId.get("tsk-0970f3")?.title).toContain("stranger loop");
    expect(byId.get("tsk-e5e110")?.status).not.toBe("in_progress");
    expect(byId.get("tsk-92ccb7")?.title).toContain("serve daemon");
    expect(byId.get("tsk-563f05")?.title).toContain("RFC absorption");
  });

  test("every active task is an RFC 0002 §18.4 lane and carries the same current-law pointer", () => {
    expect(lanes.length).toBeGreaterThan(0);
    expect(active.map((task) => task.id).sort()).toEqual(
      lanes.map((lane) => `lane-${lane}`).sort(),
    );
    for (const task of active) {
      expect(task.currentLaw).toBe(CURRENT_LAW_PATH);
      expect(task.type).toBe("lane");
      expect(task.supersededBy).toBeUndefined();
      for (const id of waveIds) {
        expect(task.blockedBy ?? []).not.toContain(id);
      }
      expect(task.title).not.toMatch(/\bpromote\b/i);
      expect(task.title).not.toMatch(/\breview loop\b/i);
      expect(task.description ?? "").not.toMatch(
        /owner review queue|owner-invoked promote|owner approval step/i,
      );
    }
    expect(byId.get("lane-serve-daemon")?.blockedBy ?? []).toEqual([]);
  });

  test("the Wave 1-6 batch and close candidate keep history and yield authority", () => {
    expect(waveBatch.batchId).toBe("kizuki-waves-20260901");
    expect(waveBatch.superseded).toBe(true);
    expect(waveBatch.supersededBy).toBe(CURRENT_LAW_PATH);
    expect(candidate.id).toBe("tsk-0970f3");
    expect(candidate.superseded).toBe(true);
    expect(candidate.supersededBy).toBe(CURRENT_LAW_PATH);
  });
});
