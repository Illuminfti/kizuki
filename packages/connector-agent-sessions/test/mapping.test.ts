import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import { FIXTURE_FILES } from "../src/fixture";
import { writeFixtureTree } from "../src/testing";
import { claudeRecord, claudeTurn, codexMeta, codexTurn, connectorFor, drain, tempRoot, texts, writeJsonl } from "./helpers";

const projectSubject = (cwd: string): string =>
  `project:${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;

test("a Claude Code transcript becomes one message event per spoken turn", async () => {
  const root = await tempRoot();
  await writeFixtureTree(root, "claude-code");
  const { events } = await drain(connectorFor("claude-code", { path: root }));

  expect(texts(events)).toEqual([
    "Let us keep the export format stable and add the importer next.",
    "Agreed. I will freeze the format and start on the importer.",
  ]);
  const [user, assistant] = events;
  expect(user).toMatchObject({
    schema: "kizuki.event/v1",
    connector_id: "kizuki.claude-code-sessions",
    source_record_id: "0a1b2c3d-1111-4222-8333-444455556666/u-1",
    kind: "message",
    occurred_at: "2026-01-15T10:00:00.000Z",
    deleted: false,
    attachments: [],
    subjects: [
      { subject_id: "session-role:user", role: "from" },
      { subject_id: projectSubject("/work/example-app"), role: "about", display_name: "example-app" },
    ],
    metadata: {
      session_id: "0a1b2c3d-1111-4222-8333-444455556666",
      uuid: "u-1",
      cwd_basename: "example-app",
      git_branch: "main",
      entrypoint: "cli",
      is_sidechain: false,
      source_file: "0a1b2c3d-1111-4222-8333-444455556666.jsonl",
      line: 2,
      tool_names: [],
    },
  });
  expect(assistant?.metadata).toMatchObject({ uuid: "a-1", parent_uuid: "u-1", tool_names: ["Read"], line: 3 });
  expect(assistant?.subjects[0]).toEqual({ subject_id: "session-role:assistant", role: "from" });
});

test("thinking, tool inputs, tool results and harness records never reach an event", async () => {
  const root = await tempRoot();
  await writeFixtureTree(root, "claude-code");
  const serialized = JSON.stringify((await drain(connectorFor("claude-code", { path: root }))).events);

  for (const leaked of ["private reasoning", "file contents", "notes.md", "Caveat: injected"]) {
    expect(serialized).not.toContain(leaked);
  }
});

test("a Codex rollout becomes message events with the session's context", async () => {
  const root = await tempRoot();
  await writeFixtureTree(root, "codex");
  const { events } = await drain(connectorFor("codex", { path: root }));

  expect(texts(events)).toEqual([
    "Switch the queue to at-least-once delivery.",
    "Done. Consumers now acknowledge after processing.",
  ]);
  expect(events[0]).toMatchObject({
    connector_id: "kizuki.codex-sessions",
    source_record_id: "0b2c3d4e-5555-4666-8777-888899990000/L2",
    occurred_at: "2026-01-15T11:00:01.000Z",
    subjects: [
      { subject_id: "session-role:user", role: "from" },
      { subject_id: projectSubject("/work/example-service"), role: "about", display_name: "example-service" },
    ],
    metadata: { session_id: "0b2c3d4e-5555-4666-8777-888899990000", git_branch: "trunk", line: 2, tool_names: [] },
  });
  expect(JSON.stringify(events)).not.toContain("never captured");
});

test("every emitted event validates and repeats identically on a second pass", async () => {
  for (const flavor of ["claude-code", "codex"] as const) {
    const root = await tempRoot();
    await writeFixtureTree(root, flavor);
    const connector = connectorFor(flavor, { path: root });
    const first = (await drain(connector)).events;
    const second = (await drain(connector)).events;

    expect(first.length).toBeGreaterThan(0);
    for (const event of first) expect(validateEventInput(event).ok).toBe(true);
    const stable = (events: typeof first) => events.map(({ observed_at: _, ...rest }) => rest);
    expect(stable(second)).toEqual(stable(first));
  }
});

test("the offline fixture is the transcripts the tests write", async () => {
  for (const flavor of ["claude-code", "codex"] as const) {
    const root = await tempRoot();
    await writeFixtureTree(root, flavor);
    const connector = connectorFor(flavor, { path: root });
    const fromDisk = (await drain(connector)).events.map((event) => event.source_record_id);

    expect((await connector.fixture()).map((event) => event.source_record_id)).toEqual(fromDisk);
    expect(Object.keys(FIXTURE_FILES[flavor])).toHaveLength(1);
  }
});

test("subagent transcripts and sidechain records are skipped unless asked for", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/main.jsonl", [
    claudeTurn("u-1", "main turn"),
    claudeTurn("u-2", "sidechain turn", { isSidechain: true }),
  ]);
  await writeJsonl(root, "proj/session-1/subagents/agent-1.jsonl", [claudeTurn("u-3", "subagent file turn", { isSidechain: true })]);

  expect(texts((await drain(connectorFor("claude-code", { path: root }))).events)).toEqual(["main turn"]);
  const all = await drain(connectorFor("claude-code", { path: root, include_subagents: true }));
  expect(texts(all.events).sort()).toEqual(["main turn", "sidechain turn", "subagent file turn"]);
  expect(all.events.filter((event) => event.metadata["is_sidechain"] === true)).toHaveLength(2);
});

test("meta records, compact summaries, unknown types and other roles are counted, not captured", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/a.jsonl", [
    claudeRecord({ uuid: "m-1", isMeta: true }),
    claudeRecord({ uuid: "m-2", isCompactSummary: true }),
    { type: "file-history-snapshot", messageId: "x" },
    claudeTurn("u-1", "kept"),
    "not json at all",
    claudeRecord({ uuid: "bad id with spaces", message: { role: "user", content: "bad identity" } }),
    claudeTurn("u-2", "bad time", { timestamp: "yesterday" }),
    claudeTurn("u-3", "<system-reminder>injected by the harness</system-reminder>"),
  ]);
  const connector = connectorFor("claude-code", { path: root });

  expect(texts((await drain(connector)).events)).toEqual(["kept"]);
  const detail = (await connector.health()).detail ?? "";
  for (const counted of ["meta=1", "compact_summary=1", "ignored_type=1", "not_json=1", "bad_identity=1", "bad_timestamp=1", "no_text=1", "events=1"]) {
    expect(detail).toContain(counted);
  }
});

test("Codex records outside message items, and developer messages, are counted, not captured", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "2026/01/15/rollout-a.jsonl", [
    codexMeta(),
    { timestamp: "2026-01-15T11:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "duplicate" } },
    {
      timestamp: "2026-01-15T11:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system rules" }] },
    },
    codexTurn("user", "<environment_context>cwd</environment_context>"),
    codexTurn("user", "the only real turn"),
  ]);
  const connector = connectorFor("codex", { path: root });

  expect(texts((await drain(connector)).events)).toEqual(["the only real turn"]);
  const detail = (await connector.health()).detail ?? "";
  expect(detail).toContain("ignored_type=1");
  expect(detail).toContain("other_role=1");
});

test("a Codex file without a session record falls back to its own name for the session id", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "2026/01/15/rollout-orphan.jsonl", [codexTurn("user", "no meta line")]);
  const { events } = await drain(connectorFor("codex", { path: root }));

  expect(events[0]?.source_record_id).toBe("rollout-orphan/L1");
  expect(events[0]?.subjects.map((subject) => subject.subject_id)).toEqual(["session-role:user"]);
});
