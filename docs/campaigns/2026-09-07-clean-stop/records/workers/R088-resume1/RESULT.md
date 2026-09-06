# Result R088

Outcome: PREPARED. Scope: current-field join and draft assertions for
context vs query source references, explicit empty results, and
unavailable evidence. No repository edits.

- Repository/worktree/branch: `/repo` git archive of
  `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (no Git metadata). Remote
  not verified in this container.
- Base, input head, final head and tree: base
  `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source head movement.
- Dirty/local-only state and owned files: `/work/out` only.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`,
  orient-repository, issue-pickup-execution, epistemic-integrity,
  cli-terminal-ux, test-strategy, handoff-work; binding
  `/repo/docs/CURRENT.md`, RFC 0002, scoped CLI/core `AGENTS.md`.
- What changed and why: preparation artifacts mapping support, citation,
  and uncertainty fields already exposed by `kizuki context` /
  `serveContextPacket` and `kizuki query` / `serveSearch`, plus a pure
  comparison adapter. No retrieval calls, no semantic quality score.
- Ownership/dependencies: feeds P086 and P099. P003/P015/P006/Astra/doctor
  remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /work/out/adapter/compare-context-query.test.ts` on synthetic fixtures; bun 1.3.14; 11 pass 0 fail; exit 0 | PASS |
| Package/type/full gate | Repository `bun test` / `bun run verify` not run: read-only archive, no Git, no root test slot | NOT_RUN |
| Privacy/diff integrity | Static: fixtures are synthetic; adapter strips `score`; no vault/provider access | PASS (static) |
| Independent review | Not assigned; self-review is not C2 | NOT_RUN |
| Retained package/consumer | No package built | NOT_RUN |

Findings first: CLI query `SearchHit` omits `CanonChunk.sources`
(`packages/cli/src/commands/query.ts:63-75`). Packet `auth=none` vs query
CLI `authority ?? "model_inference"` is an uncomparable default.
`docs/cli.md:223-226` withheld text does not match `query.ts:79`. CLI
query default scope `all` vs core search default `canon`. Context `--query`
searches canon only. These are current-code join hazards, not fixes.

Remaining risk: adapter is a draft over already-served JSON, not
integrated. Existing single-surface tests were inventoried, not re-executed.
Next smallest action: P086/P099 consume the join without treating CLI
source omission as empty sources; rebase on the live head before
production use.
