import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSupersededTaskClaims } from "./release-superseded-task-claims";

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

  test("releases the lastHeartbeatAt alias only on superseded tasks", () => {
    const historical = { id: "old", status: "superseded", lastHeartbeatAt: "2026-09-01T23:28:00Z" };
    expect(JSON.parse(releaseSupersededTaskClaims(JSON.stringify(historical))))
      .toEqual({ id: "old", status: "superseded" });
    const live = JSON.stringify({ ...historical, status: "in_progress" });
    expect(releaseSupersededTaskClaims(live)).toBe(live);
  });

  test("repairs current committed history without touching the input file", () => {
    const path = join(root, ".maestro/tasks/tasks.jsonl");
    const before = readFileSync(path, "utf8");
    const output = releaseSupersededTaskClaims(before);
    for (const line of output.trim().split("\n")) {
      const task = JSON.parse(line);
      if (task.status === "superseded") {
        for (const field of ["assignee", "claimedAt", "heartbeatAt", "leaseExpiresAt"]) {
          expect(task).not.toHaveProperty(field);
        }
      }
    }
    expect(releaseSupersededTaskClaims(output)).toBe(output);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("rejects malformed task records", () => {
    for (const input of ["null", "[]", "42", "{}", '{"id":"old"}', '{"id":1,"status":"superseded"}']) {
      expect(() => releaseSupersededTaskClaims(input)).toThrow();
    }
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
