---
name: incident-root-cause
description: Investigate a Kizuki defect, data-integrity event, security issue, CI regression, or reliability incident into an evidence-backed root cause and durable prevention without blame or speculative fixes.
---

# Incident and root-cause analysis

1. Preserve evidence without copying private user content or secrets into tickets.
2. Pin affected versions/SHAs and construct a timestamped technical timeline from receipts, commits, tests, and safe diagnostics.
3. Separate trigger, contributing conditions, detection gap, impact, and root mechanism.
4. Reproduce with synthetic state when possible.
5. Use causal reasoning such as repeated 'why' questions carefully; stop at mechanisms the system can actually change.
6. Distinguish root-cause correction from containment, recovery, and optional hardening.
7. Add a regression test that fails for the demonstrated mechanism before the durable fix when practical.
8. Review adjacent paths for the same failure class without turning the fix into an unbounded rewrite.
9. Record what would have detected or prevented the event earlier.
10. Finish with exact-head verification and residual risk.

Do not blame people, invent certainty, or call a symptom the root cause.
