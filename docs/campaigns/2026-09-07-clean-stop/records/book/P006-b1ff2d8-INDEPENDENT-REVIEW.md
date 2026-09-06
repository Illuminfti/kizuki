# P006 documentation candidate independent review

Accept `b1ff2d812bb3cd0384d0f0f6f98ed32704774cac` as the bounded documentation phase, with one nonblocking inherited wording correction below. This does not accept the capability producer, a release, or a live account.

Base: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. Candidate tree: `20fe23f62c16704abdd6a7437a49dc331a257b16`. The raw candidate commit has that base as its sole parent. Exactly the nine handoff-owned files changed, with 250 added and 28 removed lines. All 1,228 tracked working files matched their committed bytes and modes; the index matched the tree, no untracked files were present, and `git diff --check` passed. No product code or tests were executed.

The added 16-entry connector inventory matches the registrations in `packages/connectors/src/registry.ts` and admission rules in `packages/cli/src/connections.ts`. WHOOP and the X API subpath remain outside CLI enrollment. ICS URL sign-in remains a library surface. Screenpipe instructions preserve the stopped-database requirement.

The `app` and doctor `--integrity` descriptions match their commands, the loopback HTTP host, and Core's optional full ledger check. `packages/cli/src/help.ts` changes only two output strings; command groups, names, exports, interfaces and behavior are untouched. No `connect-catalog.ts`, release evaluator, capability producer or other shared runtime file changed.

Google client configuration, explicit field selection, canonical Calendar IDs and source consent match the native enrollment modules and their contracts. Telegram app-credential build gaps, account identity/checkpoint preservation, and the absence of live qualification match the accepted first-results review. Telegram code-delivery behavior remains unknown rather than universally prohibited. WHOOP secret custody remains unresolved and its public documentation is not treated as proof of rejection of Core's OAuth flow. The candidate does not infer that a provider account or application is absent merely because source cannot prove its existence.

D19 wording agrees with `docs/decision-log.md`, amended RFC 0002 section 1.3 and the three non-required superseded rows in `scripts/go-no-go.ts`. It removes calendar-duration and estate-cutover readiness prerequisites while retaining product, connector, model, security, recovery, platform, independent review and unfamiliar-human requirements.

One low-severity inherited contradiction remains: `SECURITY.md:67` still disclaims “A packaged binary or signed installer,” while `docs/CURRENT.md:37,67` and `README.md:307` describe the local Linux x64 baseline package. Change that bullet to “A published or signed installer.” This is not a newly introduced behavior regression and does not block the scoped documentation candidate.

Evidence: `P006-b1ff2d8-INDEPENDENT-REVIEW.json`. Static review only; no model, network, account, artifact, merge or release action was performed. Synthetic evidence remains distinct from connector account, copied-artifact and unfamiliar-human qualification.
