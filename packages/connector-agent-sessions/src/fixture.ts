import type { SessionFlavor } from "./config";

/** Fixed instant the offline fixture reports as its observation time. */
export const FIXTURE_NOW = "2026-01-15T12:00:00.000Z";

const CLAUDE_SESSION = "0a1b2c3d-1111-4222-8333-444455556666";
const CODEX_SESSION = "0b2c3d4e-5555-4666-8777-888899990000";

const line = (record: unknown): string => JSON.stringify(record);

const claude = {
  sessionId: CLAUDE_SESSION,
  cwd: "/work/example-app",
  gitBranch: "main",
  entrypoint: "cli",
  isSidechain: false,
};

/** Synthetic Claude Code transcript, one record per line. */
const CLAUDE_LINES = [
  line({ type: "summary", summary: "Example session", leafUuid: "u-0" }),
  line({
    ...claude,
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    timestamp: "2026-01-15T10:00:00.000Z",
    message: { role: "user", content: "Let us keep the export format stable and add the importer next." },
  }),
  line({
    ...claude,
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    timestamp: "2026-01-15T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning that is never captured" },
        { type: "text", text: "Agreed. I will freeze the format and start on the importer." },
        { type: "tool_use", id: "t-1", name: "Read", input: { file_path: "/work/example-app/notes.md" } },
      ],
    },
  }),
  line({
    ...claude,
    type: "user",
    uuid: "u-2",
    parentUuid: "a-1",
    timestamp: "2026-01-15T10:00:06.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t-1", content: "file contents that are never captured" }],
    },
  }),
  line({
    ...claude,
    type: "user",
    uuid: "u-3",
    parentUuid: "a-1",
    isMeta: true,
    timestamp: "2026-01-15T10:00:07.000Z",
    message: { role: "user", content: "Caveat: injected by the harness." },
  }),
];

/** Synthetic Codex rollout, one record per line. */
const CODEX_LINES = [
  line({
    timestamp: "2026-01-15T11:00:00.000Z",
    type: "session_meta",
    payload: { id: CODEX_SESSION, cwd: "/work/example-service", git: { branch: "trunk" }, originator: "codex_cli" },
  }),
  line({
    timestamp: "2026-01-15T11:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Switch the queue to at-least-once delivery." }],
    },
  }),
  line({
    timestamp: "2026-01-15T11:00:02.000Z",
    type: "response_item",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text: "never captured" }] },
  }),
  line({
    timestamp: "2026-01-15T11:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done. Consumers now acknowledge after processing." }],
    },
  }),
  line({
    timestamp: "2026-01-15T11:00:04.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c-1", output: "never captured" },
  }),
];

/** Relative path to lines, for each flavor. The offline fixture and the tests share it. */
export const FIXTURE_FILES: Readonly<Record<SessionFlavor, Readonly<Record<string, readonly string[]>>>> = {
  "claude-code": { [`example-app/${CLAUDE_SESSION}.jsonl`]: CLAUDE_LINES },
  codex: { [`2026/01/15/rollout-2026-01-15T11-00-00-${CODEX_SESSION}.jsonl`]: CODEX_LINES },
};
