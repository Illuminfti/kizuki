---
name: refactor-safely
description: Refactor Kizuki code without changing externally observable behavior by establishing characterization coverage, dependency boundaries, staged transformations, and exact equivalence checks. Use for cleanup, modularization, simplification, or debt removal.
---

# Safe refactoring

## Preserve behavior

1. Run `orient-repository`.
2. Define the behavior that must not change and locate all public callers.
3. Add characterization tests where behavior is implicit or weakly covered.
4. Separate mechanical structure changes from semantic changes.
5. Make one reversible transformation at a time and keep the tree runnable.

Prefer deleting duplication, shortening dependency chains, clarifying types,
and moving effects to boundaries. Do not introduce abstractions until at least
two real uses demonstrate the shared concept.

## Risk checks

Watch for accidental changes to:

- exported types and runtime shapes;
- error classes, text relied on by callers, and exit codes;
- ordering and stable serialization;
- SQLite transactions and migration behavior;
- filesystem permissions and atomic writes;
- async timing, retries, and resource lifetime;
- authorization, redaction, provenance, and purge;
- performance complexity.

For large changes, introduce the new path behind an existing contract, migrate
callers, prove equivalence, then remove the old path.

Finish with focused tests, package tests, typecheck, full verification, and a
diff review that contains no unrelated cleanup.
