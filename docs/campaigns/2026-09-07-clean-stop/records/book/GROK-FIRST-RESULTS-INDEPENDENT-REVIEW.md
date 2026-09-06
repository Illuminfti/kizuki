# Independent review of Grok preparation results P047, P059, and P095

Review date: 6 September 2026.

Product base reviewed: `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0` in the
clean exact-main artifact at
`WORKTREES/kizuki-main327-artifact-verification-20260906`.
The Grok outputs are preparation only. They provide no release, live-account,
native-artifact, or unfamiliar-user credit.

## P047 — Telegram

**Accept as preparation, with the qualifications below.** Accept
`telegram-primary-source.md`, `telegram-implemented-vs-missing.md`,
`telegram-fixture-plan.md`, `RESULT.md`, and `result.json` as a read-only
research and implementation-gap packet.

Confirmed against the product base:

- `scripts/build-release.ts` compiles the native binaries with only
  `KIZUKI_COMPILED`; it does not inline the Telegram application id and hash
  expected by `packages/connector-telegram/src/app-credentials.ts`. This is a
  real release-path gap.
- `docs/connect.md` has no Telegram setup and limitation section.
  `docs/cli.md` mentions Telegram in prose but omits it from the connection
  usage fence, while `packages/cli/src/commands/connect.ts` wires the command.
- Unknown provider RPC names fail closed as the package-owned `parse_error`.
  More specific handling and fixtures would improve diagnosis, but this is not
  itself a source-auth blocker. GramJS behavior for newer delivery types also
  remains a test question.
- Telegram API Terms section 1.5 directly restricts use of Telegram data for
  AI and ML development and deployment. Kizuki needs an owner/legal product
  disposition before native live qualification.

Correction: Telegram's authorization documentation says that **in some
conditions** only official mobile applications can receive a login code by SMS
or call, and it names other delivery methods available to third-party apps.
Do not restate this as a universal requirement for `#enableSMS`, or as proof
that every third-party account is prohibited from signing in. Target-account
delivery remains unknown until authorized live qualification.

Genuine external blockers are project `api_id`/`api_hash` registration and
custody, a compatible native release build, a live Telegram account trial, and
the Terms decision. The proposed synthetic error fixtures and public-doc fixes
are ready for separately owned implementation.

## P059 — WHOOP

**Accept the primary-source and gap inventory after correction. Reject the
decision draft as an owner decision. Revise the live-trial plan before use.**

The official public documentation says a self-generated OAuth state parameter
must be eight characters long. That documents a different shape from Core's
32-byte base64url state, but it does not prove that WHOOP rejects the roughly
43-character value. Likewise, the absence of PKCE from the public WHOOP pages
does not prove that WHOOP rejects PKCE. Loopback redirect acceptance, state
length, PKCE, and whether refresh needs `scope=offline` are compatibility
questions for a later authorized trial.

The larger unresolved issue is secret custody. WHOOP says the Client Secret
should be used only server-side and never exposed in a client, web, or mobile
application. P059's preferred operator-registered local option still handles
that secret in a desktop process. The current protected-state component also
accepts `config.client.secret` locally and needs it for refresh. Dashboard
acceptance or one successful token exchange would not by itself establish that
this custody model is sanctioned.

Therefore:

- accept `whoop-primary-source-packet.md` and `whoop-gap-map.md` as research;
- reject `whoop-decision-draft.md`'s chosen Option 2 as a sanctioned design;
- revise `whoop-live-trial-prerequisites.md` so provider/owner disposition of
  local Client Secret handling precedes account registration and token calls;
- treat `RESULT.md` and `result.json` as conditional findings, not a decision.

A WHOOP membership, Developer Dashboard app, test account, and credentials are
genuine source-auth prerequisites. They were absent and no account or provider
API calls were made. Secret-custody sanction is a design/provider-policy
blocker. State, PKCE, loopback, and refresh form behavior are unknown and need
testing; they are not confirmed provider prohibitions.

## P095 — capability and documentation inventory

**Accept the inventory, contradiction map, and D19 readiness result. Correct
the proposed follow-on ownership scope.**

Confirmed exact-base documentation defects:

- `SECURITY.md` says the CLI will not enroll IMAP or Telegram, while
  `listEnrollableConnectorIds` admits IMAP, Telegram, Gmail, and Google
  Calendar sign-in.
- root CLI help says direct account sign-in is unavailable although the
  commands are wired.
- `docs/README.md` still calls estate cutover a 1.0 prerequisite, contrary to
  D19 and the three non-required superseded rows in `scripts/go-no-go.ts`.
- the connectors README registry table is incomplete;
- `docs/cli.md` omits the `app` command and doctor `--integrity` option;
- `docs/connect.md` does not index all currently wired connection paths.

Accept `capability-inventory.json`, `contradictions.json`, and
`d19-readiness.json`. Revise `canonical-owner.json`, `RESULT.md`, and
`result.json`: remove `packages/cli/src/connect-catalog.ts` from the issue-349
documentation rewrite unless the live issue scope or a separately assigned
runtime owner explicitly includes it.

The missing friendly title for `kizuki.import-x-archive` is a real but
low-severity runtime-label defect: the catalog falls back to the raw connector
id. Record it for a separately owned code change rather than adding shared
runtime code to a documentation lane implicitly.

Accept `provider-docs.json` only as evidence that the listed public URLs were
reachable on the check date. Several bodies were not substantively parsed and
the historical X URL redirected to a generic overview, so it does not verify
the associated provider behavior claims.

No product source, remote account, credential, provider API, merge, or release
state was changed by this review.
