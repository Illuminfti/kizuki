import { expect, test } from "bun:test";
import { releaseSupersededTaskClaims } from "./release-superseded-task-claims";
import { validateMaestroState } from "./verify-maestro";

test("done-task reservations are released without losing candidate agreement", () => {
  const task = {
    id: "closed-task", status: "done", assignee: "worker-host",
    claimedAt: "2026-09-01T23:00:00Z", heartbeatAt: "2026-09-01T23:01:00Z",
    lastHeartbeatAt: "2026-09-01T23:01:00Z", leaseExpiresAt: "2026-09-01T23:02:00Z",
    completedAt: "2026-09-01T23:01:30Z", result: { summary: "Shipped" },
  };
  const candidate = { id: task.id, sourceTaskId: task.id, status: "done" };
  const output = releaseSupersededTaskClaims(JSON.stringify(task) + "\r\n");
  const released = JSON.parse(output);
  expect(released).toEqual({
    id: task.id, status: task.status, completedAt: task.completedAt, result: task.result,
  });
  expect(validateMaestroState([released], [candidate])).toEqual([]);
  expect(output.endsWith("\r\n")).toBe(true);
  expect(releaseSupersededTaskClaims(output)).toBe(output);
  const live = JSON.stringify({ ...task, status: "in_progress" });
  expect(releaseSupersededTaskClaims(live)).toBe(live);
});
