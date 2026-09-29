import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CaptureEventInput, Connector, Cursor } from "@kizuki/core";
import { createClaudeCodeSessionsConnector, createCodexSessionsConnector } from "../src";
import type { AgentSessionsConfig, AgentSessionsConnector, SessionFlavor } from "../src";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-sessions-"));
  roots.push(root);
  return root;
}

export function connectorFor(
  flavor: SessionFlavor,
  config: AgentSessionsConfig,
  now?: () => number,
): AgentSessionsConnector {
  const create = flavor === "claude-code" ? createClaudeCodeSessionsConnector : createCodexSessionsConnector;
  return create(config, now === undefined ? {} : { now });
}

export interface Drained {
  events: CaptureEventInput[];
  cursor: Cursor | null;
  pages: number;
}

/** Runs a connector to the end of one pass, the way the host does. */
export async function drain(connector: Connector, from: Cursor | null = null): Promise<Drained> {
  const events: CaptureEventInput[] = [];
  let cursor = from;
  for (let pages = 1; pages < 1000; pages += 1) {
    const batch = await connector.sync(cursor);
    events.push(...batch.events);
    cursor = batch.cursor;
    if (batch.has_more !== true) return { events, cursor, pages };
  }
  throw new Error("pass did not finish");
}

/** One Claude Code turn record. */
export function claudeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    sessionId: "session-1",
    cwd: "/work/example-app",
    gitBranch: "main",
    entrypoint: "cli",
    isSidechain: false,
    timestamp: "2026-01-15T10:00:00.000Z",
    message: { role: "user", content: "hello" },
    ...overrides,
  };
}

/** A Claude Code user turn with the given text. */
export function claudeTurn(uuid: string, text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return claudeRecord({ uuid, message: { role: "user", content: text }, ...overrides });
}

export function codexMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-01-15T11:00:00.000Z",
    type: "session_meta",
    payload: { id: "codex-session-1", cwd: "/work/example-service", git: { branch: "trunk" }, ...overrides },
  };
}

export function codexTurn(role: "user" | "assistant", text: string, at = "2026-01-15T11:00:01.000Z"): Record<string, unknown> {
  return {
    timestamp: at,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

/** Writes JSONL under `root`, one record (or raw string) per line. */
export async function writeJsonl(
  root: string,
  relpath: string,
  records: readonly unknown[],
  mtime?: Date,
): Promise<string> {
  const target = path.join(root, relpath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  if (mtime !== undefined) await utimes(target, mtime, mtime);
  return target;
}

export const texts = (events: readonly CaptureEventInput[]): string[] => events.map((event) => event.text);
