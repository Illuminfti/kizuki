import { readFileSync } from "node:fs";

/** Release obsolete reservations without changing task history or active leases. */
export function releaseSupersededTaskClaims(jsonl: string): string {
  const seen = new Set<string>();
  return jsonl
    .split("\n")
    .map((line) => {
      if (/^[ \t\r]*$/.test(line)) return line;
      const task: unknown = JSON.parse(line);
      if (
        typeof task !== "object" || task === null || Array.isArray(task) ||
        !("id" in task) || typeof task.id !== "string" || task.id.trim() === "" || task.id !== task.id.trim() ||
        !("status" in task) || typeof task.status !== "string" || task.status.trim() === "" ||
        task.status !== task.status.trim()
      ) throw new Error("Expected a task object with id and status");
      if (seen.has(task.id)) throw new Error("Duplicate task id");
      seen.add(task.id);
      if (task.status !== "superseded" && task.status !== "completed" && task.status !== "done") return line;
      const fields = ["assignee", "claimedAt", "heartbeatAt", "lastHeartbeatAt", "leaseExpiresAt"];
      if (!fields.some((field) => Object.hasOwn(task, field))) return line;
      for (const field of fields) delete (task as Record<string, unknown>)[field];
      return JSON.stringify(task) + (line.endsWith("\r") ? "\r" : "");
    })
    .join("\n");
}

// Emit a reviewable replacement; never overwrite local coordination state.
if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(2);
  if (path === undefined || extra.length > 0) {
    console.error("Usage: bun scripts/release-superseded-task-claims.ts <tasks.jsonl>");
    process.exitCode = 1;
  } else {
    try {
      // Preserve a leading BOM for JSON.parse to reject; never replace invalid bytes.
      const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
      process.stdout.write(releaseSupersededTaskClaims(input));
    } catch {
      console.error("Could not release task claims: input must be readable task JSONL.");
      process.exitCode = 1;
    }
  }
}
