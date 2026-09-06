import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CURRENT_LAW_PATH = ".maestro/current-law.json";
const TASKS_PATH = ".maestro/tasks/tasks.jsonl";
const WAVE_BATCH_PATH = ".maestro/tasks/batches/kizuki-waves-20260901.json";
const LANE_BATCH_PATH = ".maestro/tasks/batches/rfc-0002-lanes-20260906.json";
const WAVE_CANDIDATE_PATH = ".maestro/tasks/candidates/tsk-0970f3.json";
const RFC_PATH = "rfcs/0002-autonomous-canon.md";

const BINDING = [
  "rfcs/0002-autonomous-canon.md",
  "docs/CURRENT.md",
  "docs/decision-log.md",
] as const;

const WAVE_TASK_IDS = [
  "tsk-0970f3",
  "tsk-e5e110",
  "tsk-88cdae",
  "tsk-92ccb7",
  "tsk-563f05",
  "tsk-37c80e",
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
  description: string;
  type: string;
  status: string;
  currentLaw?: string;
  supersededBy?: string;
  blocks?: string[];
  blockedBy?: string[];
}

interface Batch {
  batchId: string;
  superseded?: boolean;
  supersededBy?: string;
  currentLaw?: string;
  created: { id: string; name: string; status: string }[];
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

function taskById(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    expect(map.has(task.id)).toBe(false);
    map.set(task.id, task);
  }
  return map;
}

describe("Maestro current-law ledger", () => {
  const law = readJson<CurrentLaw>(CURRENT_LAW_PATH);
  const tasks = loadTasks();
  const byId = taskById(tasks);
  const lanes = rfc0002LaneIds(readText(RFC_PATH));
  const waveBatch = readJson<Batch>(WAVE_BATCH_PATH);
  const laneBatch = readJson<Batch>(LANE_BATCH_PATH);
  const candidate = readJson<{
    id: string;
    superseded?: boolean;
    supersededBy?: string;
  }>(WAVE_CANDIDATE_PATH);
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));

  test("one current-law pointer names the three binding documents and the RFC lane table", () => {
    expect(law.id).toBe("rfc-0002-current-law");
    expect(law.binding).toEqual([...BINDING]);
    expect(law.laneTable).toEqual({
      path: RFC_PATH,
      section: "18.4",
    });
    expect(law.supersedesBatch).toBe("kizuki-waves-20260901");
    for (const path of [...BINDING, CURRENT_LAW_PATH, RFC_PATH]) {
      expect(readText(path).length).toBeGreaterThan(0);
    }
    expect(readText(".maestro/AGENTS.md")).toContain("current-law.json");
  });

  test("Wave 1-6 tasks remain on disk as superseded history, not current architecture", () => {
    expect(lanes.length).toBeGreaterThan(0);
    for (const id of WAVE_TASK_IDS) {
      const task = byId.get(id);
      expect(task, id).toBeDefined();
      if (task === undefined) continue;
      expect(task.status).toBe("superseded");
      expect(task.supersededBy).toBe(CURRENT_LAW_PATH);
      expect(ACTIVE_STATUSES.has(task.status)).toBe(false);
    }
    const wave1 = byId.get("tsk-0970f3");
    expect(wave1?.title).toContain("staging, promote");
    expect(wave1?.title).toContain("stranger loop");
    expect(wave1?.status).not.toBe("completed");
    const wave2 = byId.get("tsk-e5e110");
    expect(wave2?.status).not.toBe("in_progress");
    const wave4 = byId.get("tsk-92ccb7");
    expect(wave4?.title).toContain("serve daemon");
    expect(wave4?.status).toBe("superseded");
    const wave5 = byId.get("tsk-563f05");
    expect(wave5?.title).toContain("RFC absorption");
    expect(wave5?.status).toBe("superseded");
  });

  test("every active task is an RFC 0002 §18.4 lane and carries the same current-law pointer", () => {
    const expectedIds = lanes.map((lane) => `lane-${lane}`);
    expect(active.map((task) => task.id).sort()).toEqual([...expectedIds].sort());
    for (const task of active) {
      expect(task.currentLaw).toBe(CURRENT_LAW_PATH);
      expect(task.type).toBe("lane");
      expect(task.supersededBy).toBeUndefined();
      const blockedBy = task.blockedBy ?? [];
      for (const id of WAVE_TASK_IDS) {
        expect(blockedBy).not.toContain(id);
      }
    }
    const serve = byId.get("lane-serve-daemon");
    expect(serve?.status).toBe("pending");
    expect(serve?.blockedBy ?? []).toEqual([]);
  });

  test("no active task restores an owner review queue or promote path", () => {
    const forbidden = /owner review queue|owner-invoked promote|owner approval step/i;
    for (const task of active) {
      expect(task.title).not.toMatch(forbidden);
      expect(task.description).not.toMatch(forbidden);
      expect(task.title).not.toMatch(/\bpromote\b/i);
      expect(task.title).not.toMatch(/\breview loop\b/i);
    }
  });

  test("the Wave 1-6 batch and close candidate keep history and yield authority", () => {
    expect(waveBatch.batchId).toBe("kizuki-waves-20260901");
    expect(waveBatch.superseded).toBe(true);
    expect(waveBatch.supersededBy).toBe(CURRENT_LAW_PATH);
    expect(waveBatch.created.map((row) => row.id)).toEqual([...WAVE_TASK_IDS]);
    expect(candidate.id).toBe("tsk-0970f3");
    expect(candidate.superseded).toBe(true);
    expect(candidate.supersededBy).toBe(CURRENT_LAW_PATH);
  });

  test("the RFC 0002 lane batch is the current schedule and matches the RFC table", () => {
    expect(laneBatch.batchId).toBe("rfc-0002-lanes-20260906");
    expect(laneBatch.currentLaw).toBe(CURRENT_LAW_PATH);
    expect(laneBatch.superseded).toBeUndefined();
    expect(laneBatch.created.map((row) => row.name)).toEqual(lanes);
    expect(laneBatch.created.map((row) => row.id)).toEqual(
      lanes.map((lane) => `lane-${lane}`),
    );
    expect(laneBatch.created.every((row) => row.status === "pending")).toBe(true);
  });
});
