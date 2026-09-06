# Result P059

Outcome: FINDINGS. Scope: WHOOP confidentiality and sign-in feasibility against local-only custody and C4; decision draft only; no app registration, tokens, health-account contact, broker, or source edits.

- Repository/worktree/branch: `/repo` read-only git archive; no Git metadata, no live branch
- Base, input head, final head and tree: base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; archive sha256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`; no head movement
- Dirty/local-only state and owned files: archive untouched; owned outputs under `/work/out/`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`; skills orient-repository, issue-pickup-execution, connector-work, architecture-design, handoff-work; binding `docs/CURRENT.md`, `docs/decision-log.md` C3/C4/D19, RFC 0000 §3, RFC 0002, `docs/architecture.md`, `docs/whoop.md`, `packages/connectors/AGENTS.md`. Live issue 548 and remotes were not fetched.
- What changed and why: book-only decision packet. Public behavior of the product is unchanged. Claim: C4 compiled-in stranger WHOOP sign-in is not feasible on current official constraints without an owner exception; sanctioned local path is either keep `secret_ref` capture or later operator-registered confidential client after a live redirect/state/PKCE trial.
- Ownership/dependencies: WHOOP registry/CLI/shared OAuth knobs remain unowned by this lane. Next owner is whoever holds a WHOOP membership plus the architecture decision.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | Bun 1.3.14 `fetch` GET of public WHOOP developer docs and OpenAPI at `2026-09-06T20:52:18.867Z`; receipts in `primary-sources/fetch-index.json`, `primary-sources/fetch-index-2.json`, `evidence/primary-source-hashes.json`; static read of `packages/connector-whoop`, Core `auth/`, CLI catalog, `scripts/go-no-go.ts` on base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0` | PASS (research only) |
| Package/type/full gate | not invoked (read-only packet, no source change, no test slot) | NOT_RUN |
| Privacy/diff integrity | no repository diff; no credentials, tokens, dashboard login, or health payloads obtained | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none produced | NOT_RUN |

Findings first, severity ordered:

1. **C4 compiled-in WHOOP client conflicts with official Client Secret guidance.** Getting Started (2026-09-06): secret “should only be used server side and should never be exposed in a client, web, or mobile application.” C4 ships compiled-in project credentials. Affected invariant: C4 sign-in-not-setup plus secret custody. Required: owner exception or keep non-enrollment.
2. **No sanctioned stranger sign-in on this base.** Connector advertises `secret_ref` only, has no `signIn`, is absent from the connectors registry and CLI enrollable set. Official flow needs a registered app, exact redirect, and confidential secret. Affected: C3 inventory / go-no-go live-account row. Required: do not claim `kizuki connect whoop`.
3. **Core loopback/PKCE/state are unproven against WHOOP.** Docs: redirect examples `https://` or `whoop://`; state “must be eight characters long”; PKCE never mentioned. Core: `http://127.0.0.1:<ephemeral>/callback`, ~43-char state, always S256. Affected: `signInWithBrowser` reuse. Required: live trial, not a silent Core weaken.
4. **Hosted HTTPS broker is architecturally out of bounds.** Documented `https://` redirect would fit a server; RFC 0000 §3 forbids hosted services. Required: owner RFC if ever chosen; this packet did not design one.
5. **Refresh `scope=offline` mismatch (documented vs Core).** WHOOP sample POST includes `scope`; Core `refreshTokens` does not send it. Hypothesis until live refresh: may be required or optional. Do not change Core in this wave.

Hypotheses (not confirmed): dashboard might accept loopback HTTP despite omitting it; eight-character state might be a minimum; extra PKCE parameters might be ignored. All labeled unproven in the live-trial note.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: WHOOP app/account access missing — live trial UNRESOLVED. Full verify NOT_RUN. GitHub issue 548 body not retrieved. Next smallest action: owner picks decision 1 or 4 in `whoop-decision-draft.md`; a human operator with a WHOOP membership may then run the bounded live trial in `whoop-live-trial-prerequisites.md`. No merge, release, or semantic-quality claim.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted. No credentials, private records, raw provider payloads, or owner-vault paths.
