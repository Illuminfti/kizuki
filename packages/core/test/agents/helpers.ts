import { Database } from "bun:sqlite";
import { initAgents } from "../../src/agents";

export function agentsDb(): Database {
  const db = new Database(":memory:");
  initAgents(db);
  return db;
}
