import { readFileSync } from "node:fs";

// A committed snapshot is history, not a live lease store. Export a detached
// copy so local coordination files and their running workers remain untouched.
export function exportTaskState(text: string): string {
  return text.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const task: unknown = JSON.parse(line);
    if (task === null || typeof task !== "object" || Array.isArray(task) ||
        !("id" in task) || typeof task.id !== "string" || task.id.trim() === "" ||
        !("status" in task) || typeof task.status !== "string") {
      throw new Error("Invalid task record");
    }
    const snapshot: Record<string, unknown> = { ...task };
    for (const field of ["assignee", "claimedAt", "heartbeatAt", "leaseExpiresAt"]) {
      delete snapshot[field];
    }
    if (snapshot["status"] === "in_progress") snapshot["status"] = "pending";
    return JSON.stringify(snapshot);
  }).join("\n") + (text.trim().length > 0 ? "\n" : "");
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    console.error("Usage: bun scripts/export-task-state.ts <tasks.jsonl> (writes snapshot to stdout)");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(exportTaskState(readFileSync(path, "utf8")));
    } catch {
      console.error("Task snapshot export failed: unreadable or malformed input");
      process.exitCode = 1;
    }
  }
}
