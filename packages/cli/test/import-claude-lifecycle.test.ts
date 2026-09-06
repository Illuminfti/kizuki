import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, readSince } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

const PRE_CAPTURE_WARNING =
  "degraded: Claude health check before capture found partial or unsupported content.";

const CLEAN_HUMAN = "Where should the data live?";
const CLEAN_ASSISTANT = "On the owner's disk.";
const PARTIAL_TEXT = "lapis lantern stays on disk";

const CLEAN_EXPORT = [
  {
    uuid: "conversation-clean-1",
    name: "Clean fixture",
    created_at: "2026-01-01T09:00:00Z",
    chat_messages: [
      {
        uuid: "human-clean-1",
        sender: "human",
        text: CLEAN_HUMAN,
        created_at: "2026-01-01T09:00:01Z",
      },
      {
        uuid: "assistant-clean-1",
        sender: "assistant",
        text: CLEAN_ASSISTANT,
        created_at: "2026-01-01T09:00:02Z",
      },
    ],
  },
];

const PARTIAL_EXPORT = [
  {
    uuid: "conversation-partial-1",
    name: "Partial fixture",
    created_at: "2026-01-01T09:00:00Z",
    chat_messages: [
      {
        uuid: "human-partial-1",
        sender: "human",
        text: PARTIAL_TEXT,
        created_at: "2026-01-01T09:00:01Z",
        content: [
          { type: "text", text: PARTIAL_TEXT },
          { type: "tool_use", name: "search" },
        ],
      },
    ],
  },
];

const h = createHelpers();
afterEach(h.cleanup);

function writeExport(root: string, body: unknown): string {
  const path = join(root, "conversations.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function importClaude(
  env: Record<string, string | undefined>,
  source: string,
  consent: string[] = [],
) {
  return h.runCli(env, "import", "import-claude", "--source", source, ...consent);
}

function storedTexts(vault: string): string[] {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    return readSince(db, null, 32).events.map((event) => event.text);
  } finally {
    db.close();
  }
}

function connectionCount(vault: string): number {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    return listConnections(db).length;
  } finally {
    db.close();
  }
}

function warningLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line === PRE_CAPTURE_WARNING);
}

function assertWarningIsBounded(stderr: string, source: string, ...secrets: string[]) {
  expect(warningLines(stderr)).toEqual([PRE_CAPTURE_WARNING]);
  expect(stderr).not.toContain(source);
  expect(stderr).not.toContain("records=");
  expect(stderr).not.toContain("unsupported_part");
  expect(stderr).not.toContain("captured snapshot");
  expect(stderr).not.toContain("exact snapshot");
  for (const secret of secrets) expect(stderr).not.toContain(secret);
}

test("a clean two-message Claude export imports without a health warning and repeats store nothing", () => {
  const setup = h.tempVault();
  const source = writeExport(setup.root, CLEAN_EXPORT);
  const consent = fixtureConsent(setup.root);

  const first = importClaude(setup.env, source, consent);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.stdout).toContain("events_stored=2");
  expect(first.stdout).toContain("duplicates=0");
  expect(first.stdout).toContain("errors=0");
  expect(warningLines(first.stderr)).toEqual([]);
  expect(storedTexts(setup.vault)).toEqual([CLEAN_HUMAN, CLEAN_ASSISTANT]);

  const repeat = importClaude(setup.env, source);
  expect(repeat.exitCode, repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("events_stored=0");
  expect(repeat.stdout).toContain("duplicates=0");
  expect(repeat.stdout).toContain("errors=0");
  expect(warningLines(repeat.stderr)).toEqual([]);
  expect(storedTexts(setup.vault)).toEqual([CLEAN_HUMAN, CLEAN_ASSISTANT]);
});

test("an unsupported Claude content part keeps supported text and warns before capture on initial and repeat import", () => {
  const setup = h.tempVault();
  const source = writeExport(setup.root, PARTIAL_EXPORT);
  const consent = fixtureConsent(setup.root);

  const first = importClaude(setup.env, source, consent);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.stdout).toContain("events_stored=1");
  expect(first.stdout).toContain("duplicates=0");
  expect(first.stdout).toContain("errors=0");
  expect(first.stdout).not.toContain(PRE_CAPTURE_WARNING);
  assertWarningIsBounded(first.stderr, source, PARTIAL_TEXT, "tool_use", "search");
  expect(storedTexts(setup.vault)).toEqual([PARTIAL_TEXT]);

  const repeat = importClaude(setup.env, source);
  expect(repeat.exitCode, repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("events_stored=0");
  expect(repeat.stdout).toContain("duplicates=0");
  expect(repeat.stdout).toContain("errors=0");
  expect(repeat.stdout).not.toContain(PRE_CAPTURE_WARNING);
  assertWarningIsBounded(repeat.stderr, source, PARTIAL_TEXT, "tool_use", "search");
  expect(storedTexts(setup.vault)).toEqual([PARTIAL_TEXT]);
});

test("blocked Claude health still refuses enrollment and does not emit the pre-capture warning", () => {
  const setup = h.tempVault();
  const source = writeExport(setup.root, { uuid: "not-an-array" });

  const result = importClaude(setup.env, source, fixtureConsent(setup.root));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("error: kizuki.import-claude health=misconfigured:");
  expect(warningLines(result.stderr)).toEqual([]);
  expect(result.stderr).not.toContain(source);
  expect(result.stderr).not.toContain("not-an-array");
  expect(connectionCount(setup.vault)).toBe(0);
  expect(storedTexts(setup.vault)).toEqual([]);
});

test("source consent still blocks Claude capture before any pre-capture health warning", () => {
  const setup = h.tempVault();
  const source = writeExport(setup.root, PARTIAL_EXPORT);

  const denied = h.runCli(setup.env, "import", "import-claude", "--source", source);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("source_capture_denied");
  expect(denied.stderr).toContain("connect grant --source");
  expect(warningLines(denied.stderr)).toEqual([]);
  expect(storedTexts(setup.vault)).toEqual([]);
});
