import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Committed history and lane definitions are not a live worker lease store.
export function validateMaestroState(tasks: unknown[], candidates: unknown[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const checkRecord = (value: unknown, label: string): value is Record<string, unknown> => {
    if (!isRecord(value) || typeof value["id"] !== "string" || value["id"].trim() === "") {
      errors.push(`${label}: invalid record or id`);
      return false;
    }
    for (const field of ["assignee", "claimedAt", "heartbeatAt", "lastHeartbeatAt", "leaseExpiresAt"]) {
      if (Object.hasOwn(value, field)) errors.push(`${label}: forbidden worker field ${field}`);
    }
    if (value["status"] === "in_progress") errors.push(`${label}: live reservation in committed state`);
    return true;
  };
  tasks.forEach((task, index) => {
    const label = `task ${index + 1}`;
    if (!checkRecord(task, label)) return;
    const id = task["id"] as string;
    if (typeof task["status"] !== "string" || task["status"].trim() === "") {
      errors.push(`${label}: missing status`);
    }
    if (byId.has(id)) errors.push(`${label}: duplicate task id`);
    byId.set(id, task);
  });
  const candidateIds = new Set<string>();
  candidates.forEach((candidate, index) => {
    const label = `candidate ${index + 1}`;
    if (!checkRecord(candidate, label)) return;
    const id = candidate["id"] as string;
    if (candidateIds.has(id)) errors.push(`${label}: duplicate candidate id`);
    candidateIds.add(id);
    const source = candidate["sourceTaskId"];
    const task = typeof source === "string" ? byId.get(source) : undefined;
    // Legacy close candidates omit status; an explicit status must agree.
    if (task && Object.hasOwn(candidate, "status") &&
        candidate["status"] !== "in_progress" && candidate["status"] !== task["status"]) {
      errors.push(`${label}: explicit status disagrees with source task`);
    }
    if (!task || candidate["id"] !== source) {
      errors.push(`${label}: missing or mismatched source task`);
    } else if (task["status"] === "superseded") {
      if (candidate["superseded"] !== true || typeof task["supersededBy"] !== "string" ||
          task["supersededBy"].trim() === "" || candidate["supersededBy"] !== task["supersededBy"]) {
        errors.push(`${label}: supersession disagrees with source task`);
      }
    } else if (task["status"] !== "done" || candidate["superseded"] === true ||
        Object.hasOwn(candidate, "supersededBy")) {
      errors.push(`${label}: close candidate disagrees with source task status`);
    }
  });
  return errors;
}

if (import.meta.main) {
  try {
    const root = join(import.meta.dir, "..", ".maestro", "tasks");
    const tasks = readFileSync(join(root, "tasks.jsonl"), "utf8")
      .split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    const candidates = readdirSync(join(root, "candidates"))
      .filter(name => name.endsWith(".json")).sort()
      .map(name => JSON.parse(readFileSync(join(root, "candidates", name), "utf8")));
    const errors = validateMaestroState(tasks, candidates);
    for (const error of errors) console.error(error);
    if (errors.length > 0) process.exitCode = 1;
    else console.log("Maestro committed state verification passed");
  } catch {
    console.error("Maestro committed state is missing or malformed");
    process.exitCode = 1;
  }
}
