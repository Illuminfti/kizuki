# Result R055

Outcome: FINDINGS. Scope: Gmail live `messageEvent` output-schema map plus
neutral minimal-metadata and attachment-only fixtures for headers, labels,
thread id, and excluded-attachment markers.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata);
  worker write scope `/work/out` only; owner grok-R055
- Base, input head, final head and tree: base_sha
  `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json);
  no checkout mutation; archive_sha256
  `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`
- Dirty/local-only state and owned files: repository untouched; artifacts only
  under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`,
  `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`,
  `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md` D19, RFC 0002,
  orient-repository, issue-pickup-execution, connector-work, test-strategy,
  handoff-work. Remote/GitHub state was not refreshed (container adaptation).
- What changed and why: no product code. Preparation map of current mapper
  output for P051/P052.
- Ownership/dependencies: shared connector registry, core event contract, and
  Gmail package remain with their owners. Feeds P051, P052. P006 owns canonical
  docs.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/check-gmail-event-mapping.ts` at 2026-09-06T22:02Z, bun 1.3.14, archive base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; stdout `gmail event mapping check: 2 fixtures + coverage contrast PASS`; exit 0 | PASS |
| Package/type/full gate | `bun test` / `bunx tsc` / `bash scripts/verify.sh` | NOT_RUN (no node_modules; install forbidden) |
| Privacy/diff integrity | static: synthetic `@example.test` fixtures only; no credentials or owner data | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none built | NOT_RUN |

Findings first, severity ordered:

1. `packages/connector-gmail/src/events.ts:65-66,113` — `attachment_body_unsupported`
   and `mime_projection_limited_depth_8` are computed during MIME walk then
   discarded unless `text` is selected. Attachment-only events persist
   `attachments_downloaded: false` and `body_coverage: ["body_not_selected"]`
   only. Independent README expectation is that those limits are reported.
2. `events.ts:117` — tombstones drop `thread_id`.
3. `events.ts:44-50` — only depth-0 `from|to|cc|subject|date|content-type`
   survive; RFC `Message-ID` and nested part headers do not.

Remaining risk: existing package tests were not re-executed (missing
`@kizuki/core` workspace install). No live Gmail account. Mapping check rewrites
the `@kizuki/core` import specifier onto a leaf shim; mapper body is the current
source text. Next smallest action: P051/P052 consume the map and fixtures; if
coverage tokens must survive attachment-only capture, that is a later owned
code change, not this packet.
