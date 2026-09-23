import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTaskState } from "./export-task-state";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

describe("detached task snapshot export", () => {
  test("drops worker fields and reopens reservations without changing history", () => {
    const rows = [
      { id: "lane-capture", status: "in_progress", assignee: "test-host", claimedAt: "old", heartbeatAt: "old", leaseExpiresAt: "old", title: "Capture" },
      { id: "wave-1", status: "superseded", assignee: "test-host", supersededBy: ".maestro/current-law.json" },
      { id: "wave-2", status: "done", title: "Finished work" },
    ];
    const result = exportTaskState(rows.map(row => JSON.stringify(row)).join("\n"));
    expect(result.split("\n").filter(Boolean).map(line => JSON.parse(line))).toEqual([
      { id: "lane-capture", status: "pending", title: "Capture" },
      { id: "wave-1", status: "superseded", supersededBy: ".maestro/current-law.json" },
      rows[2],
    ]);
    expect(rows[0]?.assignee).toBe("test-host");
    expect(exportTaskState(result)).toBe(result);
  });

  test("drops the heartbeat alias from every detached task status", () => {
    for (const status of ["pending", "in_progress", "superseded", "done", "completed"]) {
      const input = JSON.stringify({ id: "lane-test", status, lastHeartbeatAt: "old", title: "History" });
      const output = exportTaskState(input);
      expect(JSON.parse(output)).toEqual({
        id: "lane-test", status: status === "in_progress" ? "pending" : status, title: "History",
      });
      expect(exportTaskState(output)).toBe(output);
    }
  });

  test("empty input stays empty and malformed input fails atomically", () => {
    expect(exportTaskState("\n  \n")).toBe("");
    for (const input of ["null", "[]", "{}", '{"id":"","status":"pending"}', '{"id":"a","status":null}', '{"id":"a","status":"done"}\ninvalid']) {
      expect(() => exportTaskState(input)).toThrow();
    }
  });

  test("CLI writes only a detached snapshot and never edits its input", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-task-export-"));
    try {
      const input = join(root, "tasks.jsonl");
      const original = '{"id":"lane-test","status":"in_progress","assignee":"test-host","lastHeartbeatAt":"old"}\n';
      writeFileSync(input, original);
      const command = [process.execPath, join(import.meta.dir, "export-task-state.ts"), input];
      const result = Bun.spawnSync(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('{"id":"lane-test","status":"pending"}\n');
      expect(readFileSync(input, "utf8")).toBe(original);
      writeFileSync(input, original + "invalid");
      const failure = Bun.spawnSync(command);
      expect(failure.exitCode).toBe(1);
      expect(failure.stdout.toString()).toBe("");
      expect(failure.stderr.toString()).not.toContain("test-host");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
