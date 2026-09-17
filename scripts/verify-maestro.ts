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
    if (!isRecord(value) || typeof value["id"] !== "string" || value["id"].trim() === "" ||
        value["id"] !== value["id"].trim()) {
      errors.push(`${label}: invalid record or id`);
      return false;
    }
    for (const field of ["assignee", "claimedAt", "heartbeatAt", "lastHeartbeatAt", "leaseExpiresAt"]) {
      if (Object.hasOwn(value, field)) errors.push(`${label}: forbidden worker field ${field}`);
    }
    if (typeof value["status"] === "string" && value["status"] !== value["status"].trim()) {
      errors.push(`${label}: invalid status`);
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
    if (task["status"] === "superseded" &&
        (typeof task["supersededBy"] !== "string" || task["supersededBy"].trim() === "")) {
      errors.push(`${label}: missing supersession reference`);
    }
    if (task["status"] === "superseded" && typeof task["supersededBy"] === "string" &&
        task["supersededBy"].trim() !== "" && task["supersededBy"] !== task["supersededBy"].trim()) {
      errors.push(`${label}: invalid supersession reference`);
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
    if (Object.hasOwn(candidate, "superseded") && typeof candidate["superseded"] !== "boolean") {
      errors.push(`${label}: invalid superseded flag`);
    }
    const source = candidate["sourceTaskId"];
    const task = typeof source === "string" ? byId.get(source) : undefined;
    if (!task || candidate["id"] !== source) {
      errors.push(`${label}: missing or mismatched source task`);
    } else if (Object.hasOwn(candidate, "status") && candidate["status"] !== task["status"] &&
        candidate["status"] !== "in_progress") {
      errors.push(`${label}: candidate status disagrees with source task`);
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

// Preserve a leading BOM so JSON validation rejects it rather than silently
// accepting bytes that the previous UTF-8 file reader would have rejected.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

if (import.meta.main) {
  try {
    const root = join(import.meta.dir, "..", ".maestro", "tasks");
    // Committed state is evidence: malformed bytes must fail closed instead of
    // being silently replaced with replacement characters before validation.
    const tasks = decoder.decode(readFileSync(join(root, "tasks.jsonl")))
      .split("\n").filter(line => !/^[ \t\r]*$/.test(line)).map(line => JSON.parse(line));
    const candidates = readdirSync(join(root, "candidates"))
      .filter(name => name.endsWith(".json")).sort()
      .map(name => JSON.parse(decoder.decode(readFileSync(join(root, "candidates", name)))));
    const errors = validateMaestroState(tasks, candidates);
    for (const error of errors) console.error(error);
    if (errors.length > 0) process.exitCode = 1;
    else console.log("Maestro committed state verification passed");
  } catch {
    console.error("Maestro committed state is missing or malformed");
    process.exitCode = 1;
  }
}
