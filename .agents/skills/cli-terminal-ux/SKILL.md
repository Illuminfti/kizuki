---
name: cli-terminal-ux
description: Design or review Kizuki CLI and terminal UX for composability, safe interaction, stable output, accessibility, hostile text rendering, confirmations, and excellent failure recovery.
---

# CLI and terminal UX

1. Start from the user's job and public command seam, not internal object structure.
2. Make defaults safe and useful. Destructive or authority-changing actions require explicit intent.
3. Keep stdout machine-usable when promised; diagnostics and progress belong on stderr.
4. Define stable exit codes, argument validation, help text, examples, and actionable errors.
5. Never print secrets. Redact sensitive values and avoid echoing hostile captured text unnecessarily.
6. Neutralize ANSI/control sequences and terminal escape injection in untrusted content.
7. Design interruption, retry, cancellation, partial failure, non-TTY use, narrow terminals, and repeated invocation.
8. Canon writes are not confirmed by the owner; they are receipted and reversible (docs/decision-log.md D9, D10). Reserve typed confirmation for irreversible local operations such as `purge`, and for `undo` in the audit surface (RFC 0002 §7.3).
9. Test commands end-to-end with temporary synthetic state, including snapshots only where semantics are not obscured.
10. Prefer one obvious workflow over aliases and flags that expose implementation trivia.
