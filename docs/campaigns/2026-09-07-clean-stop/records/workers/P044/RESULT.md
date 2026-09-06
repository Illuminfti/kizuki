# Result P044

Outcome: FINDINGS. Scope: freeze local-app public-journey acceptance oracle for workspace/source/import/recall/correct/audit/undo/revoke/reload on archived base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; no UI/source edits; Astra retains browser/host implementation.

- Repository/worktree/branch: read-only git archive at `/repo`; no Git metadata; remote not verified in this container
- Base, input head, final head and tree: base = input = `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; archive SHA-256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`; no final product head (book only)
- Dirty/local-only state and owned files: product tree untouched; owned outputs only under `/work/out/`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`; repo `AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`, `rfcs/0000-constraints.md`, `docs/architecture.md`, `docs/local-app.md`; skills orient-repository, issue-pickup-execution, test-strategy, ux-dx-ax-parity, security-privacy-review, handoff-work; elegance-review bar (read-only)
- What changed and why: book-only oracle, test plan, capability matrix, qualification-lane split, static security and parity notes. Public product behavior unchanged.
- Ownership/dependencies: Astra owns `packages/cli/src/app/browser.ts` and host implementation. Root owns remotes, test slots, integration. No overlapping write on `/work/out/`.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test packages/cli/test/app-host.test.ts packages/cli/test/app-client.test.ts packages/cli/test/app-browser.test.ts packages/cli/test/app-service.test.ts packages/core/test/serve/app-http.test.ts` on `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; Bun 1.3.14; `node_modules` absent; 2026-09-06T21:15:04Z | NOT_RUN |
| Package/type/full gate | `bun run typecheck` / `bun run verify` | NOT_RUN |
| Privacy/diff integrity | Static read of app HTTP/host/client; no product diff; standing-token test exists in source; no credentials printed | PASS (static) |
| Independent review | This worker is the specification/security/regression prep lens on the frozen archive; C2 independent-model lens not run (controller forbade other models) | NOT_RUN |
| Retained package/consumer | No artifact built | NOT_RUN |

Findings first, severity ordered:

1. Medium — `packages/cli/src/app/host.ts` query cap 2000 vs `packages/core/src/serving/search.ts` 512; oversized search becomes `unavailable`; `client.js` `humanError` then says the connection needs setup. Invariant: unavailable ≠ empty ≠ operator-misconfig. Fix: align cap and error copy.
2. Medium — `client.js` `renderMemory` ignores protocol `withheld`. Invariant: RFC 0000 tri-state / policy-hidden rows are not “nothing matched”. Fix: render withheld distinctly.
3. Low — Host allow-list advertises `misconfigured`, `consent_required`, `revision_conflict` that `host.ts` never throws; several Core grant codes collapse to `unavailable`. Invariant: honest codes. Fix: pass through Core codes.
4. Low — Reload boot (`hash` → `sessionStorage` → `refresh`) and new-host token rotation lack tests. Invariant: same-host resume vs new-host 401. Fix: cases REL-SESSIONSTORAGE-BOOT, REL-NEW-HOST.
5. Low — App recall binds `retrieval: 'none'` while CLI query uses `optional`. Invariant: do not imply hybrid search. Fix: keep lexical-only until a degraded signal exists; document in the oracle (done).

Hypotheses, not confirmed at runtime: Calendar `primary` refusal on the app enroll path; `source_capture_denied` exact code on pre-grant capture (failure is asserted, code is not); 10-batch capture bound; `close()` `custody_unknown`.

Remaining risk: no focused tests executed; GitHub issue 458 live discussion unread; no real browser/account/supervisor. Next smallest action: implement gap cases from `oracle-cases.json` in existing test files on an assigned write lane, without taking Astra’s browser/host files unless root reassigns.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row. No merge, deploy, or comment was performed. No credentials, private records, or owner-vault paths.
