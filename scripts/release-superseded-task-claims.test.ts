import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSupersededTaskClaims } from "./release-superseded-task-claims";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const root = join(import.meta.dir, "..");

describe("release superseded task claims", () => {
  test("removes reservations from the committed task schema, preserving history", () => {
    const task = {
      id: "tsk-e5e110", status: "superseded", assignee: "worker-host",
      claimedAt: "2026-09-01T23:27:12.262Z", heartbeatAt: "2026-09-01T23:28:00Z",
      leaseExpiresAt: "2026-09-01T23:29:00Z", supersededBy: ".maestro/current-law.json",
      closeReason: "Stale in_progress claim released", blockedBy: ["tsk-0970f3"],
    };
    const result = JSON.parse(releaseSupersededTaskClaims(JSON.stringify(task)));
    expect(result).toEqual({ id: task.id, status: task.status,
      supersededBy: task.supersededBy, closeReason: task.closeReason, blockedBy: task.blockedBy });
  });

  test("releases completed reservations while preserving completion evidence", () => {
    const completed = {
      id: "done", status: "completed", assignee: "lane-1",
      claimedAt: "2026-09-01T23:27:12Z", heartbeatAt: "2026-09-01T23:28:00Z",
      lastHeartbeatAt: "2026-09-01T23:28:00Z", leaseExpiresAt: "2026-09-01T23:29:00Z",
      completedAt: "2026-09-01T23:28:30Z", result: { commit: "abc123" },
    };
    const output = releaseSupersededTaskClaims(JSON.stringify(completed));
    expect(JSON.parse(output)).toEqual({
      id: completed.id, status: completed.status,
      completedAt: completed.completedAt, result: completed.result,
    });
    expect(releaseSupersededTaskClaims(output)).toBe(output);
  });

  test("CLI releases completed claims without changing live claims or source bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-claims-"));
    const path = join(dir, "tasks.jsonl");
    const completed = '{"id":"done","status":"completed","assignee":"lane-1","completedAt":"2026-09-01T23:28:30Z"}';
    const live = ' {"id":"live", "status":"in_progress", "assignee":"lane-2"}';
    const pending = '{"id":"pending","status":"pending","assignee":"lane-3"}';
    const input = `${completed}\r\n${live}\r\n\r\n${pending}\n`;
    try {
      writeFileSync(path, input);
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "release-superseded-task-claims.ts"), path], {
        timeout: 5000, killSignal: "SIGKILL",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const output = result.stdout.toString();
      expect(output).toBe(`{"id":"done","status":"completed","completedAt":"2026-09-01T23:28:30Z"}\r\n${live}\r\n\r\n${pending}\n`);
      expect(releaseSupersededTaskClaims(output)).toBe(output);
      expect(readFileSync(path, "utf8")).toBe(input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("releases a superseded lastHeartbeatAt without changing a live heartbeat", () => {
    const old = { id: "old", status: "superseded", lastHeartbeatAt: "2026-09-01T23:28:00Z" };
    const live = ' {"id":"live", "status":"in_progress", "lastHeartbeatAt":"2026-09-01T23:28:00Z"}';
    const input = `${JSON.stringify(old)}\n${live}\n`;
    const output = releaseSupersededTaskClaims(input);
    expect(output).toBe(`{"id":"old","status":"superseded"}\n${live}\n`);
    expect(releaseSupersededTaskClaims(output)).toBe(output);
  });

  test("repairs current committed history without touching the input file", () => {
    const path = join(root, ".maestro/tasks/tasks.jsonl");
    const before = readFileSync(path, "utf8");
    const output = releaseSupersededTaskClaims(before);
    for (const line of output.trim().split("\n")) {
      const task = JSON.parse(line);
      if (task.status === "superseded") {
        for (const field of ["assignee", "claimedAt", "heartbeatAt", "lastHeartbeatAt", "leaseExpiresAt"]) {
          expect(task).not.toHaveProperty(field);
        }
      }
    }
    expect(releaseSupersededTaskClaims(output)).toBe(output);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("rejects non-JSON whitespace lines without changing valid blank lines", () => {
    const task = '{"id":"old","status":"superseded","assignee":"worker-host"}';
    for (const padding of ["\u00a0", "\ufeff", "\u000b", "\u000c"]) {
      expect(() => releaseSupersededTaskClaims(`${task}\n${padding}\n`)).toThrow();
    }
    expect(releaseSupersededTaskClaims(`${task}\r\n \t\r\n`))
      .toBe('{"id":"old","status":"superseded"}\r\n \t\r\n');
  });

  test("rejects malformed task records", () => {
    for (const input of ["null", "[]", "42", "{}", '{"id":"old"}', '{"id":1,"status":"superseded"}',
      '{"id":"","status":"superseded","assignee":"worker-host"}',
      '{"id":"   ","status":"superseded","assignee":"worker-host"}',
      '{"id":"old","status":""}', '{"id":"old","status":"   "}']) {
      expect(() => releaseSupersededTaskClaims(input)).toThrow();
    }
  });

  test("rejects padded task IDs rather than treating them as distinct lanes", () => {
    for (const id of [" old", "old ", "old\t", "\nold"]) {
      const input = JSON.stringify({ id, status: "superseded", assignee: "worker-host" });
      expect(() => releaseSupersededTaskClaims(input)).toThrow("Expected a task object with id and status");
    }
  });

  test("rejects padded statuses instead of silently preserving stale reservations", () => {
    for (const status of [" superseded", "superseded ", "superseded\t", "\nin_progress"]) {
      const input = JSON.stringify({ id: "old", status, assignee: "worker-host" });
      expect(() => releaseSupersededTaskClaims(input)).toThrow("Expected a task object with id and status");
    }
  });

  test("rejects conflicting duplicate task IDs rather than emitting ambiguous claims", () => {
    const old = '{"id":"lane-a","status":"superseded","assignee":"lane-1"}';
    const live = '{"id":"lane-a","status":"in_progress","assignee":"lane-2"}';
    for (const input of [`${old}\n${live}`, `${live}\n${old}`, `${old}\n${old}`]) {
      expect(() => releaseSupersededTaskClaims(input)).toThrow("Duplicate task id");
    }
  });

  test("preserves CRLF separators while releasing obsolete reservations", () => {
    const old = '{"id":"old","status":"superseded","assignee":"worker-host"}';
    const live = ' {"id":"live", "status":"in_progress", "assignee":"lane-1"}';
    const input = `${old}\r\n${live}\r\n`;
    const output = releaseSupersededTaskClaims(input);
    expect(output).toBe(`{"id":"old","status":"superseded"}\r\n${live}\r\n`);
    expect(releaseSupersededTaskClaims(output)).toBe(output);
  });

  test("preserves live tasks and already-clean lines byte for byte", () => {
    const input = ' {"id":"lane-a", "status":"in_progress", "assignee":"lane-1"}\n\n{"id":"old","status":"superseded"}\n';
    expect(releaseSupersededTaskClaims(input)).toBe(input);
  });

  test("CLI emits the replacement and fails without partial output for invalid JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-claims-"));
    const path = join(dir, "tasks.jsonl");
    const run = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "release-superseded-task-claims.ts"), path]);
    try {
      const input = '{"id":"old","status":"superseded","assignee":"worker-host"}\n';
      writeFileSync(path, input);
      const ok = run();
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.toString()).toBe('{"id":"old","status":"superseded"}\n');
      expect(readFileSync(path, "utf8")).toBe(input);
      writeFileSync(path, input + "not-json\n");
      const bad = run();
      expect(bad.exitCode).toBe(1);
      expect(bad.stdout.toString()).toBe("");
      const duplicate = input + '{"id":"old","status":"in_progress","assignee":"lane-2"}\n';
      writeFileSync(path, duplicate);
      const ambiguous = run();
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stdout.toString()).toBe("");
      expect(ambiguous.stderr.toString()).toBe("Could not release task claims: input must be readable task JSONL.\n");
      expect(readFileSync(path, "utf8")).toBe(duplicate);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
