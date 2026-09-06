# P006 current product documentation repair

Root authorizes this docs phase now on f57 after the independent P095 review.
Use GROK-FIRST-RESULTS-INDEPENDENT-REVIEW.md and context P095 inventory. Correct
present-tense claims from actual source; do not claim release acceptance.

Own exactly README.md, SECURITY.md, docs/README.md, docs/CURRENT.md, docs/cli.md,
docs/connect.md, docs/release-acceptance.md, packages/connectors/README.md,
and documentation-only help text in packages/cli/src/help.ts. In help.ts preserve
all command groups, names, exports, interfaces, parsing and behavior; fix only the
stale statement that native sign-in is unavailable. Do not edit connect-catalog.

Required concrete corrections where present: SECURITY must reflect wired native
IMAP/Telegram/Gmail/Calendar enrollment and current custody/qualification limits;
CLI docs index app, doctor --integrity and every wired connect path including
Telegram; connect docs give truthful source-specific setup and missing external
qualification, without saying an app/account is absent merely because source
cannot prove its presence. Connector README inventory must match runtime registry.
D19 removes mandatory seven/fourteen-day calendar and estate-cutover release gates;
retain all product, connector, model, security, recovery, platform, independent
review and real unfamiliar-human requirements. Historical observations can remain
clearly historical. No newly invented provider claims; use source and reviewed
primary evidence, preserving Telegram and WHOOP limitations from review.

The capability-proof producer is a later P006 phase dependent on P004; do not
create it or change release evaluators in this phase. Avoid blanket rewrites.
Run no model/account/network calls. No new tests for simple prose changes.
Write a coherent scoped candidate commit and report exact changed paths and
which source facts support each correction. Root runs verification.
