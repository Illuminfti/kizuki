# Import Beacon agent runs

Kizuki can import an explicitly selected local Beacon `runtime.jsonl` snapshot.
This captures source evidence through the existing event ledger, source grants,
import checkpoints and purge lifecycle. It does not install Beacon, collect
harness directories, execute hooks, contact a hosted service, or write skills.

## Import and consent

```sh
kizuki import beacon --source /absolute/path/runtime.jsonl \
  --policy /absolute/path/source-policy.json \
  --expected-revision 0 --operation-id beacon-first-import
```

`beacon` is an alias for `kizuki.import-beacon`; `import-beacon` also works.
Use the existing [source consent policy](cli.md#source-consent) format. The
grant must allow capture, text and metadata. Other uses need their own purpose
permissions. Capture defaults to private; this adapter has no network egress.
Enrollment without a grant refuses capture and prints the grant command.
An existing active grant allows later imports without repeating policy options.

Only the selected file is read. Export paths, executable names, commands, tool
arguments and repository paths inside records are data, never instructions to
open files or run tools. The source file is left unchanged, including during
Kizuki source revocation and purge. To revoke, use `connect revoke --source KEY`
and `connect resume-revocation` as described in the CLI source-consent guide.

## Supported upstream format

Evaluated 2026-09-21 against MIT-licensed
[Asymptote Labs Beacon, commit 793524a9bae85bf5f7963da002e171c8bbebf136](https://github.com/Asymptote-Labs/agent-beacon/tree/793524a9bae85bf5f7963da002e171c8bbebf136).
This is Kizuki-owned adapter code; no Beacon code, prompts, binaries or personal
fixtures are distributed. Beacon's agent-run evidence approach also informed
this capture seam. There is no runtime dependency or hosted service contract.

The accepted envelope has `vendor: beacon`, `product: endpoint-agent`,
`schema_version: "1.0"`, `event.kind: agent_runtime`, an RFC3339 timestamp,
nonempty `event.category`, severity, endpoint OS, and `harness.name` of
`claude_code` or `codex`.
Hook, poll, OTLP and plugin collection labels are retained when present.
Native Claude conversation JSONL and Codex rollout JSONL are different formats
and are refused here. Supported normalized actions are:

| Evidence | Actions |
| --- | --- |
| Sessions | `session.started`, `session.ended`, `session.context`, `session.status`, `session.summary` |
| Conversation | `prompt.submitted`, `agent.message`, `agent.reasoning` |
| Tools | `tool.invoked`, `tool.completed`, `tool.failed`, `command.executed`, `file.read`, `file.modified`, `mcp.tool_invoked` |
| Other run evidence | `token.usage`, `approval.requested`, `approval.allowed`, `approval.denied`, `subagent.started`, `subagent.stopped` |

The adapter validates this envelope and Core's JSON bounds; nested source
payloads remain attributed evidence rather than a second typed outcome schema.
The complete parsed source record is retained under `metadata.beacon.record`,
including session, harness, user, tool-call IDs, command result, repository/run
attribution, source fidelity and content-retention markers. Text contains a
canonical source report. Explicit `gen_ai.system_instructions` are retained
only in source metadata, separate from that task evidence text. All imported
content, including prompts and commands, remains untrusted source data.

Beacon `fidelity: observed`, a successful exit code, an approval or a completion
message does not acquire native owner authority or independently prove a
successful outcome. This upstream revision has no canonical user-correction
field: a correcting prompt is a user-attributed source message. The importer
does not invent a correction, confidence score, lesson, or success verdict.

## Identity, errors and limits

- Native `event.id` is preserved with the harness in a length-delimited source
  record identity. Missing IDs use the full SHA-256 of the canonical source
  record, explicitly in a different identity domain. Accepted snapshots sort by
  RFC3339 timestamp, then Beacon's optional per-writer sequence (which starts
  at 1), then source-record identity. A missing sequence has a deterministic
  local sort bucket only; it makes no causal or global ordering claim. Local
  sequence numbers never become global IDs. Capture binds the event to the enrolled source;
  another enrollment cannot take over an existing event binding.
- Exact repeats deduplicate. A changed snapshot is rescanned through the
  shared digest/offset cursor. Changed content under an existing ID in a later
  snapshot follows the ledger's revision semantics: it is another revision of
  the same source record, **not independent corroboration**. Missing-ID content
  fallbacks cannot establish lineage after edits; downstream learning must
  retain this uncertainty rather than count them as independent evidence.
- Conflicting versions of the same ID within one snapshot are both excluded
  and reported. Smaller exports do not imply deletion. Source revocation is
  the existing consent and purge operation; this file importer cannot delete
  anything in Beacon or the original harness.
- One UTF-8 regular file, at most 16 MiB and 20,000 lines; each JSONL record is
  at most 64 KiB, matching the pinned Beacon writer. Core metadata depth,
  array, key and string bounds also apply. Symlinks and malformed UTF-8 refuse.
  Unknown schemas, harnesses and actions are reported as unsupported records.
- Valid records can be captured alongside malformed records, but the run
  reports `partial_import` and cannot claim a completed checkpoint. Diagnostics
  include bounded reason codes and counts, never source text or private IDs.
  Oversized records are skipped with an error; Kizuki does not truncate them.
  Upstream truncation and redaction markers remain in the source evidence.

This is the capture seam. Cross-client lesson extraction, evaluation against
independent outcomes, project-scoped learning and model-driven reuse require
their own implementation and evidence. Import success does not establish them.

## Verification

```sh
bun test packages/connectors/test/import-beacon.test.ts packages/connectors/test/conformance.test.ts
bun test packages/cli/test/import-beacon-lifecycle.test.ts
```

Fixtures are synthetic normalized Claude/Codex records. They exercise source
consent, nested attribution, replay and revisions, foreign source refusal,
malformed bounds, checkpoint resume, source purge, and public export/restore.
No live-account or real-harness qualification is claimed. Future upstream
format changes require fixture and compatibility review; useful upstream
schema clarifications should be proposed upstream separately.
