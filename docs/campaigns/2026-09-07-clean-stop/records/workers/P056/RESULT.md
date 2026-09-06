# Result P056

Outcome: FINDINGS. Scope: read-only IMAP protocol inventory, synthetic MIME/UID oracles, and auth/live-qualification matrix on base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`. No source edits, no mailbox connection, no live-account claim.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; remote not verified in this container
- Base, input head, final head and tree: base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; archive sha256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`; no new HEAD
- Dirty/local-only state and owned files: `/work/out/**` only
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `handoff-work`; repo `AGENTS.md`, `packages/connectors/AGENTS.md`, `docs/CURRENT.md`, `docs/connect.md`, `packages/connector-imap/**`
- What changed and why: book packet only — command inventory, expected records, auth matrix
- Ownership/dependencies: shared registry/lockfiles untouched; live IMAP qualification remains a separate owner-authorized step

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | Synthetic oracle via copied `packages/connector-imap` + core-type stub; `bun /workTEMP/imap-run/generate.ts` 2026-09-06; no `/repo` test run | PASS (oracle generation) |
| Package/type/full gate | `bun test packages/connector-imap`, `bun run typecheck`, `bun run verify` | NOT_RUN (`/repo` read-only; no test slot) |
| Privacy/diff integrity | No credentials printed; fixtures use `acme.example`; smoke env not set; `/grokstate/auth.json` not read | PASS (static) |
| Independent review | No code change | NOT_RUN |
| Retained package/consumer | None | NOT_RUN |
| Live mailbox | Forbidden by packet | NOT_RUN |

Findings first, severity ordered:

1. **Live IMAP qualification is absent.** `scripts/go-no-go.ts` still requires live-account evidence for `kizuki.imap`. Smoke test does not inspect FLAGS. Affected invariant: advertised connector vs D19/live proof. Required fix: owner-authorized FLAGS-before/after receipt on a LOGIN-capable IMAPS server — not this packet.
2. **OAuth-only providers cannot use this client.** Microsoft 365 basic auth is retired; Gmail IMAP docs specify `AUTHENTICATE XOAUTH2`. Implementation has LOGIN only (`session.ts`). Required fix: separate OAuth lane or honest catalog exclusion — not claimed supported here.
3. **`packages/connector-imap/README.md` Sign-in section is stale** relative to `packages/cli/src/commands/connect.ts` and `docs/connect.md`, which already implement `kizuki connect imap`. README still says no CLI verb drives it. Book-only; no edit.
4. **`fixture()` header-only UID 11 is not what `walkMailboxes` does at default size.** Walk uses `RFC822.SIZE > max_message_bytes`. Oracle records both. Do not treat `fixture()` section HEADER as the walk path.
5. **Wave1 spec cursor is missing `pending`.** `docs/wave1/specs/connector-imap-ics.md` §3.2 omits the `pending` field implemented in `cursor.ts`. Spec is historical; implementation+tests are the contract.

Remaining risk: full gate NOT_RUN; provider IMAP how-to pages 404 for Proton and Fastmail's dedicated app-password article (Fastmail server-names page still documents app-specific passwords). Next smallest action: owner-authorized LOGIN IMAPS FLAGS witness, or an implementation lane that consumes these oracles without expanding to XOAUTH2 unless assigned.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted from this row.
