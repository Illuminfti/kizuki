// Synthetic normalized records shaped after MIT Beacon 793524a. No personal
// transcripts, execution, hooks or upstream runtime are used by fixtures.
const base = {
  timestamp: "2026-09-21T12:00:00.123456789Z", vendor: "beacon", product: "endpoint-agent", schema_version: "1.0",
  severity: "info", endpoint: { hostname: "fixture-host", os: "linux" }, user: { name: "fixture-user", uid: "1000" },
};
export const BEACON_FIXTURE_EXPORT = [
  { ...base, sequence: 1, event: { id: "fixture-claude-prompt", kind: "agent_runtime", action: "prompt.submitted", fidelity: "observed" },
    harness: { name: "claude_code", collection_method: "hook" }, session: { id: "claude-fixture", working_directory: "/synthetic/project" },
    prompt: { text: "Use the local test fixture instead of calling the hosted service." } },
  { ...base, sequence: 2, event: { id: "fixture-codex-tool", kind: "agent_runtime", action: "tool.invoked", fidelity: "observed" },
    harness: { name: "codex", collection_method: "poll" }, session: { id: "codex-fixture", working_directory: "/synthetic/project" },
    tool: { name: "exec_command", command: "bun test" }, gen_ai: { tool: { call: { id: "call-fixture", arguments: { cmd: "bun test" } } } } },
  { ...base, sequence: 3, event: { id: "fixture-codex-result", kind: "agent_runtime", action: "command.executed", fidelity: "observed" },
    harness: { name: "codex", collection_method: "poll" }, session: { id: "codex-fixture" },
    command: { command: "bun test", exit_code: 1, output: "1 test failed" }, gen_ai: { tool: { call: { id: "call-fixture", result: "1 test failed" } } } },
  { ...base, sequence: 4, event: { id: "fixture-codex-status", kind: "agent_runtime", action: "session.status", fidelity: "observed" },
    harness: { name: "codex", collection_method: "poll" }, session: { id: "codex-fixture" },
    message: "Codex task completed", raw: { codex_session: { payload_type: "task_complete", turn_id: "turn-fixture", duration_ms: 1200 } } },
];
