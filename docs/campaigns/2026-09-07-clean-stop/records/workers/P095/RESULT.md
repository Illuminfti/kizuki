# Result P095

Outcome: FINDINGS. Scope: exact-base capability and documentation gap inventory for `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; no shared documentation rewrite; D19 retained.

- Repository/worktree/branch: `/repo` read-only git archive of exact base; no Git metadata; no live branch
- Base, input head, final head and tree: base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; archive sha256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`; no head movement; no source diff
- Dirty/local-only state and owned files: source clean; owned outputs under `/work/out/`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, orient-repository, issue-pickup-execution, documentation-accuracy, ux-dx-ax-parity, release-readiness, handoff-work; binding `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`
- What changed and why: book-only inventory mapping advertised commands, contracts, registry/enrollment, packages, platforms, and security claims to file+symbol and existing proof; named contradictions and the sole docs/manifest integration owner
- Ownership/dependencies: grok-P095 owns `/work/out` only. Shared public-surface rewrite needs one root-assigned issue-349 follow-on lane. Held 519/530 remain untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /tmp && BUN_INSTALL_CACHE_DIR=TEMP/bun-cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=TEMP/bun-transpiler bun TEMP/p095-gating.ts` on base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`, Bun 1.3.14, 2026-09-06; empty `kizuki.acceptance-evidence/v2` index; decision `NO-GO`; 41 gates; superseded D19 rows `required: false` | PASS (inventory evidence; not product GO) |
| Provider primary docs | Bun fetch of Beeper, Sealgate, Google, Telegram, WHOOP, X, bun.sh URLs on 2026-09-06; receipts in `provider-docs.json` | PASS with limits (HTML not fully parsed; X URL redirected to `docs.x.com/overview`) |
| Live CLI/registry import | `bun TEMP/p095-extract.ts` from `/repo` | FAIL (no `@kizuki/*` modules; inventory used static reads) |
| Package/type/full gate | `bun run verify` / `bun test` / `bun run typecheck` | NOT_RUN (read-only archive, no node_modules, no test slot) |
| Privacy/diff integrity | No source edits; no vault/credentials; no `/grokstate/auth.json` | PASS (scope) |
| Independent review | Not a code change; C2 independent-model lens not assigned | NOT_RUN |
| Retained package/consumer | No native package built or retained | NOT_RUN |

Findings first, severity ordered:

1. `SECURITY.md:33-35` vs `packages/cli/src/connections.ts#listEnrollableConnectorIds`: SECURITY.md says the CLI will not enroll Telegram/IMAP; code and CURRENT.md enroll IMAP, Telegram, Gmail, and Google Calendar. Affected invariant 10. Required fix: one docs owner rewrites SECURITY.md.
2. `packages/cli/src/help.ts:117` says direct account sign-in is unavailable while `connectCommand` wires those sign-in verbs. Required fix: same owner.
3. `docs/README.md:22-23` still treats estate cutover as an RFC 0002 §1.3 requirement. D19 and the amended RFC retain stranger proof and drop cutover as a readiness gate. Required fix: same owner; do not restore seven/fourteen-day gates.
4. `packages/connectors/README.md` registry table omits beeper, telegram, gmail, imap, ics, and estate importers that `enroll()` registers.
5. `docs/cli.md` omits `app` and doctor `--integrity`. `docs/connect.md` covers only Beeper and IMAP.
6. ICS URL `signInIcs` is implemented but not CLI-bound; estate-slice apply is not implemented; WHOOP and X API packages exist and are not registered.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: GitHub issue 349 body and held 519/530 were not fetched. No live-account or copied-artifact proof exists. `surface.capabilities-and-docs` stays `NOT_IMPLEMENTED`. Next smallest action: root assigns one issue-349 docs/manifest integration lane to rewrite the exclusive public-surface paths listed in `canonical-owner.json`, following `COMMANDS`, `defaultConnectorRegistry`, `listEnrollableConnectorIds`, `TOOLS`, `PORT_CONTRACTS`, `scripts/go-no-go.ts#POLICY`, and `docs/CURRENT.md`.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row. No merge, deploy, release, or settings changes. No credentials or owner-vault paths.
