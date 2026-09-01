---
name: repository-archaeology
description: Understand unfamiliar Kizuki code before changing it by tracing history, public seams, invariants, callers, tests, RFCs, and prior fixes. Use for legacy areas, confusing intent, regressions, or when a tempting rewrite lacks context.
---

# Repository archaeology

1. Run `orient-repository` and pin live state.
2. Start from the public seam and trace imports, exports, callers, tests, storage, and side effects inward.
3. Use `git log -- path`, `git blame`, relevant commits, PRs/issues, RFCs, and tests to recover why a constraint exists.
4. Distinguish current invariant from historical accident. Tests are evidence, not automatically specification.
5. Search for parallel implementations, deprecated paths, migration compatibility, and hidden consumers before deleting or changing contracts.
6. Build a compact map: entrypoint -> domain logic -> persistence/effects -> output, plus trust boundaries.
7. Identify contradictions among code, docs, tests, and RFCs explicitly.
8. Only then choose repair, refactor, deprecation, or RFC work.

Never replace unfamiliar code merely because a fresh implementation looks cleaner. Preserve discovered intent in tests or documentation when it matters.
